// Pure logic shared by server and client. Everything here is tested in test.js.

// No I/O/0/1 — 3 letters, ~13k codes. Only *active* parties need uniqueness.
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

export function newCode(taken = new Set()) {
  for (let i = 0; i < 500; i++) {
    let c = ''
    for (let j = 0; j < 3; j++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    if (!taken.has(c)) return c
  }
  throw new Error('no free party codes')
}

/**
 * A person's code, as opposed to a party's.
 *
 * Six letters rather than three: a party code is shouted across a room and dies
 * in an hour, a friend code is typed once and kept forever, so collisions matter
 * far more than brevity. 24^6 is about 191 million.
 */
export function newUserCode(taken = new Set()) {
  for (let i = 0; i < 800; i++) {
    let c = ''
    for (let j = 0; j < 6; j++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    if (!taken.has(c)) return c
  }
  throw new Error('no free friend codes')
}

/** Pair key for anything held between two people — same value from either side. */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * https://soundcloud.com/artist/track -> the canonical URL.
 *
 * SoundCloud's widget takes the track URL directly, so there is nothing to
 * resolve and no key to hold: w.soundcloud.com/player?url=<this>.
 */
export function parseSoundCloud(url) {
  const m = String(url || '').trim()
    .match(/^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/([\w-]+\/(?:sets\/)?[\w-]+)(?:[?#]|$)/i)
  return m ? `https://soundcloud.com/${m[1]}` : null
}

/** open.spotify.com/track/ID, or a spotify:track:ID URI. Ids are always 22 chars. */
export function parseSpotify(url) {
  const m = String(url || '').trim()
    .match(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?|spotify:)(track|album|playlist|episode)[/:]([A-Za-z0-9]{22})/i)
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null
}

/**
 * https://pixeldrain.com/u/GKBvQx7Y -> GKBvQx7Y
 *
 * A bare id used to be accepted too, but any 8-letter word matches that shape —
 * "nonsense" was being resolved to a PixelDrain file. Requiring the domain keeps
 * the guess out of it.
 */
export function parsePixeldrain(url) {
  const m = String(url || '').trim().match(/pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9]+)/)
  return m ? m[1] : null
}

export function pixeldrainFile(id) {
  return `https://pixeldrain.com/api/file/${id}`
}

// watch?v=, youtu.be/, /shorts/, /embed/, /live/ — all carry the same 11-char id.
export function parseYouTube(url) {
  const s = String(url || '').trim()
  const m = s.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  )
  return m ? m[1] : null
}

/**
 * What kind of thing did the owner paste?
 *
 *  kind 'file'    — we fetch the bytes ourselves and play them in <video>.
 *  kind 'youtube' — we can't touch the bytes; YouTube's own player is embedded
 *                   and driven through the IFrame API. Costs us no bandwidth.
 */
export function resolveSource(url) {
  const yt = parseYouTube(url)
  if (yt) return { kind: 'youtube', source: yt, origin: `https://www.youtube.com/watch?v=${yt}` }

  // Music. Both play in the host's own embed, so no bytes touch this server and
  // neither needs a key, a token or a registered application.
  const sc = parseSoundCloud(url)
  if (sc) return { kind: 'soundcloud', source: sc, origin: sc }

  const sp = parseSpotify(url)
  if (sp) {
    return {
      kind: 'spotify',
      source: `${sp.type}/${sp.id}`,
      origin: `https://open.spotify.com/${sp.type}/${sp.id}`,
    }
  }

  const id = parsePixeldrain(url)
  if (id) return { kind: 'file', source: pixeldrainFile(id), origin: pixeldrainFile(id), id }

  if (/^https:\/\/\S+\.(mp4|webm|m4v|mov)(\?\S*)?$/i.test(url)) {
    const clean = url.trim()
    return { kind: 'file', source: clean, origin: clean, id: null }
  }
  return null
}

/**
 * Guess a quality label from a file name or URL — "11eyes 003 720p.mp4" -> "720p".
 * One mp4 has exactly one quality, so the only way to offer a choice is for the
 * host to add alternate links; labelling them by hand would be tedious.
 */
export function qualityLabel(nameOrUrl, fallback = 'Source') {
  const s = String(nameOrUrl || '')
  const p = s.match(/(?:^|[^0-9a-z])(\d{3,4})[pi](?![0-9a-z])/i)
  if (p) return `${p[1]}p`
  if (/(^|[^a-z0-9])(4k|2160)(?![a-z0-9])/i.test(s)) return '2160p'
  if (/(^|[^a-z0-9])(1440)(?![a-z0-9])/i.test(s)) return '1440p'
  return fallback
}

/**
 * Seconds of video a viewer must have downloaded *ahead of the playhead*.
 *
 * Buffer, not readyState: readyState climbs to "can play" the instant a single
 * frame lands, so a viewer on a thin connection reads as healthy right up to
 * the moment they stall again. Seconds-in-hand is the thing that actually
 * predicts whether they can keep going.
 *
 * `low` and `resume` are deliberately far apart. Stopping the room at one level
 * and restarting it at the same level guarantees oscillation — the room resumes
 * the moment the buffer touches the line, drains it, and stops again a second
 * later. Two levels make it a Schmitt trigger: fall below `low` to stop, climb
 * past `resume` to go again.
 */
export const BUF = {
  start: 4, // must be in hand before the countdown will run at all
  low: 0.8, // below this you have genuinely run out of video
  resume: 5, // and this much must be back before the room moves again
  stray: 15, // drift this large means lost, not merely slow
}

/**
 * Who is holding the room up. `need` is the buffer each viewer must have — the
 * caller picks it, because the answer differs depending on what the room is
 * doing (see BUF). `skipped` members are ignored: the host chose to leave them.
 *
 * A member who has never reported gets the benefit of the doubt rather than
 * freezing the party for someone whose first tick is a fraction of a second away.
 */
export function holdingUp(members, roomTime, need = BUF.low, stray = BUF.stray) {
  return members.filter(
    (m) =>
      m.online &&
      m.approved &&
      !m.skipped &&
      ((m.buf ?? need) < need || roomTime - (m.t ?? roomTime) > stray)
  )
}

/**
 * Client-side drift correction.
 *
 * Seeking is expensive in a way that isn't obvious: on a file streamed through
 * us it abandons everything buffered ahead and opens a fresh range request, so
 * a viewer who is nudged with a seek every time they slip a second is a viewer
 * whose buffer never gets to grow. So seeking is the last resort — reserved for
 * someone genuinely lost — and everything short of that is corrected by leaning
 * on the playback rate, which costs nothing and is inaudible.
 *
 * The rate is proportional to the drift so it eases back in rather than
 * stepping between two fixed speeds.
 */
export function syncAction(localTime, roomTime, tol = BUF.stray) {
  const drift = roomTime - localTime
  if (Math.abs(drift) > tol) return { seek: roomTime, rate: 1 }
  if (Math.abs(drift) > 0.3) return { seek: null, rate: clamp(1 + drift / 12, 0.9, 1.1) }
  return { seek: null, rate: 1 }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Crown goes to the longest-present member still online.
export function nextOwner(members, currentOwnerId) {
  const c = members
    .filter((m) => m.online && m.approved && m.id !== currentOwnerId)
    .sort((a, b) => a.joinedAt - b.joinedAt)
  return c[0]?.id ?? null
}
