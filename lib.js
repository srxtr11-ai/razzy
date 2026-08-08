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

// Who is holding the room up: buffering, or more than `tol` seconds behind the room clock.
// `skipped` members are ignored — the owner has chosen to leave them behind.
export function laggards(members, roomTime, tol = 5) {
  return members.filter(
    (m) => m.online && m.approved && !m.skipped && (m.buffering || roomTime - (m.t ?? roomTime) > tol)
  )
}

// Client-side drift correction. Small drift is corrected by playbackRate, big drift by seeking.
export function syncAction(localTime, roomTime, tol = 1.5) {
  const drift = roomTime - localTime
  if (Math.abs(drift) > 10) return { seek: roomTime, rate: 1 }
  if (Math.abs(drift) > tol) return { seek: roomTime, rate: 1 }
  if (Math.abs(drift) > 0.25) return { seek: null, rate: drift > 0 ? 1.05 : 0.95 }
  return { seek: null, rate: 1 }
}

// Crown goes to the longest-present member still online.
export function nextOwner(members, currentOwnerId) {
  const c = members
    .filter((m) => m.online && m.approved && m.id !== currentOwnerId)
    .sort((a, b) => a.joinedAt - b.joinedAt)
  return c[0]?.id ?? null
}
