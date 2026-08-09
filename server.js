import Fastify from 'fastify'
import fstatic from '@fastify/static'
import { WebSocketServer } from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  BUF, newCode, newUserCode, pairKey, parsePixeldrain, qualityLabel,
  resolveSource, holdingUp, nextOwner,
} from './lib.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = process.env.DATA_DIR || path.join(HERE, 'data') // Railway volume mounts here
const AVATARS = path.join(DATA, 'avatars')
fs.mkdirSync(AVATARS, { recursive: true })

const OWNER_GRACE_MS = Number(process.env.OWNER_GRACE_MS) || 60_000 // crown passes after this
const ROOM_TTL_MS = 10 * 60_000 // empty room dies after this
// Two different clocks, because they answer different questions. A seat stops
// counting against the cap quickly — a reconnect takes seconds, and a room that
// reports "full" with nobody in it is unusable. Being *forgotten* takes longer,
// so someone who comes back inside a few minutes still walks into their own
// identity instead of queueing for approval again.
const SEAT_HOLD_MS = Number(process.env.SEAT_HOLD_MS) || 90_000
const MEMBER_TTL_MS = Number(process.env.MEMBER_TTL_MS) || 3 * 60_000
const DEAD_SOCKET_MS = 15_000 // no pong for this long: the connection is a corpse
const MAX_MSG = 500
const CHAT_KEEP = 200
const TYPING_TTL_MS = 4000 // typing flag self-expires; clients don't reliably say 'stopped'
const SFX_COOLDOWN_MS = 1500 // a soundboard without one is a weapon

/* ---------------------------------------------------------------- storage */

const db = new DatabaseSync(path.join(DATA, 'party.db'))
db.exec(`CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)`)
const saveStmt = db.prepare(`INSERT INTO rooms (code,data,updated) VALUES (?,?,?)
  ON CONFLICT(code) DO UPDATE SET data=excluded.data, updated=excluded.updated`)
const dropStmt = db.prepare(`DELETE FROM rooms WHERE code = ?`)

/** Everything except live sockets. Members come back as offline after a redeploy. */
const snapshot = (r) => ({
  code: r.code, cap: r.cap, ownerId: r.ownerId, sources: r.sources || [], phase: r.phase, t: r.t, paused: r.paused,
  members: [...r.members.values()].map(({ ws, ...m }) => ({ ...m, online: false, ready: false, buf: 0 })),
})

// Rooms change every second; writing the database every second per room is a
// synchronous disk write in the middle of the clock tick for no benefit. The
// copy only has to be good enough to survive a redeploy.
const dirty = new Set()
const persist = (r) => dirty.add(r.code)
setInterval(() => {
  for (const code of dirty) {
    const r = rooms.get(code)
    if (r) saveStmt.run(code, JSON.stringify(snapshot(r)), Date.now())
  }
  dirty.clear()
}, 5000)

/* ------------------------------------------------------------------ rooms */

/** code -> room. Live state; the db copy is only a redeploy parachute. */
const rooms = new Map()

for (const row of db.prepare(`SELECT data FROM rooms`).all()) {
  const s = JSON.parse(row.data)
  rooms.set(s.code, {
    ...s,
    paused: true,
    phase: s.phase === 'playing' ? 'playing' : 'idle',
    // Everyone is offline the instant we come back up. Start their grace window
    // now, so the ones who reconnect keep their seat and the ones who don't
    // stop occupying it — a restored room used to come back permanently "full"
    // of people who were never coming back.
    members: new Map(s.members.map((m) => [m.id, { ...m, ws: null, online: false, leftAt: Date.now() }])),
    chat: [],
    ownerGoneAt: Date.now(),
    emptyAt: Date.now(),
  })
}

const online = (r) => [...r.members.values()].filter((m) => m.online)

/**
 * Seats in use. A seat belongs to whoever is here now plus anyone who dropped
 * recently and is probably reconnecting — counting people who left an hour ago
 * is what made rooms report "full" with nobody in them.
 */
const seats = (r) =>
  [...r.members.values()].filter(
    (m) => m.approved && (m.online || (m.leftAt && Date.now() - m.leftAt < SEAT_HOLD_MS))
  ).length

/** How much buffer everyone needs right now, given what the room is doing. */
function needNow(r) {
  if (r.phase === 'ready' || r.phase === 'countdown') return BUF.start
  if (r.phase !== 'playing') return 0
  // While already stopped for someone, demand the higher figure — see BUF.
  return r.paused && r.pausedBy === null ? BUF.resume : BUF.low
}

function publicRoom(r) {
  const waiting = holdingUp([...r.members.values()], r.t, needNow(r)).map((m) => m.id)
  return {
    code: r.code, cap: r.cap, ownerId: r.ownerId, sources: r.sources || [],
    phase: r.phase, t: r.t, paused: r.paused, pausedBy: r.pausedBy || null, waiting,
    members: [...r.members.values()].map((m) => ({
      id: m.id, name: m.name, avatar: m.avatar, approved: m.approved, online: m.online,
      ready: !!m.ready, paused: !!m.paused, focus: !!m.focus,
      // Seconds in hand, and the flag the UI draws from it.
      buf: m.buf ?? null, buffering: m.online && (m.buf ?? BUF.low) < BUF.low,
      coHost: !!m.coHost,
      // Typing expires on its own. A client that goes to focus mode, closes the
      // tab or just stops mid-word never sends "stopped", so a sticky flag left
      // people permanently "typing…".
      typing: !!(m.online && m.typingAt && Date.now() - m.typingAt < TYPING_TTL_MS),
      skipped: !!m.skipped, ping: m.ping ?? null, joinedAt: m.joinedAt,
    })),
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function broadcast(r, msg) {
  for (const m of r.members.values()) send(m.ws, msg)
}

function pushState(r) {
  const s = publicRoom(r)
  broadcast(r, { type: 'state', room: s })
  persist(r)
}

function say(r, text, kind = 'system') {
  const msg = { id: randomUUID(), kind, text, at: Date.now() }
  r.chat.push(msg)
  if (r.chat.length > CHAT_KEEP) r.chat.shift()
  broadcast(r, { type: 'chat', msg })
}

function destroy(r) {
  rooms.delete(r.code)
  dropStmt.run(r.code)
}

/**
 * Avatar files belong to the person, not to a seat in a room.
 *
 * They used to be deleted the moment a membership ended — leaving a party,
 * being removed, the room closing, the reaper. Once identity outlived the room
 * that meant your own picture was deleted when you walked out of a party, and
 * you and everyone who had you as a friend saw an empty circle from then on.
 *
 * So nothing deletes them by hand any more. Instead this sweeps for files no
 * user and no live member points at. The hour of grace covers a picture that has
 * been uploaded but not yet attached to anything.
 */
function sweepAvatars() {
  const keep = new Set()
  for (const row of db.prepare(`SELECT avatar FROM users WHERE avatar IS NOT NULL`).all()) {
    if (row.avatar?.startsWith('/avatars/')) keep.add(path.basename(row.avatar))
  }
  for (const r of rooms.values()) {
    for (const m of r.members.values()) {
      if (m.avatar?.startsWith('/avatars/')) keep.add(path.basename(m.avatar))
    }
  }
  fs.readdir(AVATARS, (err, files) => {
    if (err) return
    const cutoff = Date.now() - 3600_000
    for (const f of files) {
      if (keep.has(f)) continue
      const full = path.join(AVATARS, f)
      fs.stat(full, (e, st) => {
        if (!e && st.mtimeMs < cutoff) fs.rm(full, { force: true }, () => {})
      })
    }
  })
}
setInterval(sweepAvatars, 6 * 3600_000)
setTimeout(sweepAvatars, 60_000)

/* --------------------------------------------------------------- people */

/**
 * Parties are disposable; people are not. A room lives for an evening, but a
 * friend list has to survive the browser being closed, the app being reinstalled
 * and this server being redeployed — so unlike rooms, which live in memory with
 * the database as a parachute, all of this *is* the database.
 *
 * Still no accounts and no passwords. Identity is the random id the client
 * generated for itself; `code` is the shareable half and `key` the half that
 * lets someone reclaim that identity on a new device.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, key TEXT NOT NULL,
    name TEXT, avatar TEXT, seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friends (
    pair TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL,
    asked TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
    -- the running score at Stack, counted in the pair's own a/b order
    winsA INTEGER NOT NULL DEFAULT 0, winsB INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dms (
    id TEXT PRIMARY KEY, pair TEXT NOT NULL, fromId TEXT NOT NULL,
    text TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'user'
  );
  CREATE INDEX IF NOT EXISTS dms_pair ON dms (pair, at);
`)

// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a database made
// before the scoreboard existed needs the columns adding by hand. Each throws if
// it is already there, which is the only way SQLite offers to ask.
for (const col of ['winsA INTEGER NOT NULL DEFAULT 0', 'winsB INTEGER NOT NULL DEFAULT 0', 'draws INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE friends ADD COLUMN ${col}`) } catch {}
}
try { db.exec(`ALTER TABLE dms ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'`) } catch {}

const q = {
  user: db.prepare(`SELECT * FROM users WHERE id = ?`),
  userByCode: db.prepare(`SELECT * FROM users WHERE code = ?`),
  codes: db.prepare(`SELECT code FROM users`),
  addUser: db.prepare(`INSERT INTO users (id,code,key,name,avatar,seen) VALUES (?,?,?,?,?,?)`),
  touchUser: db.prepare(`UPDATE users SET name = ?, avatar = ?, seen = ? WHERE id = ?`),
  seenUser: db.prepare(`UPDATE users SET seen = ? WHERE id = ?`),
  links: db.prepare(`SELECT * FROM friends WHERE a = ? OR b = ?`),
  link: db.prepare(`SELECT * FROM friends WHERE pair = ?`),
  addLink: db.prepare(`INSERT INTO friends (pair,a,b,asked,accepted,at) VALUES (?,?,?,?,0,?)`),
  acceptLink: db.prepare(`UPDATE friends SET accepted = 1 WHERE pair = ?`),
  winA: db.prepare(`UPDATE friends SET winsA = winsA + 1 WHERE pair = ?`),
  winB: db.prepare(`UPDATE friends SET winsB = winsB + 1 WHERE pair = ?`),
  drawn: db.prepare(`UPDATE friends SET draws = draws + 1 WHERE pair = ?`),
  dropLink: db.prepare(`DELETE FROM friends WHERE pair = ?`),
  addDm: db.prepare(`INSERT INTO dms (id,pair,fromId,text,at,kind) VALUES (?,?,?,?,?,?)`),
  dmPage: db.prepare(`SELECT * FROM dms WHERE pair = ? ORDER BY at DESC LIMIT 200`),
  lastDm: db.prepare(`SELECT * FROM dms WHERE pair = ? ORDER BY at DESC LIMIT 1`),
  trimDms: db.prepare(
    `DELETE FROM dms WHERE pair = ? AND at < (SELECT MIN(at) FROM (SELECT at FROM dms WHERE pair = ? ORDER BY at DESC LIMIT 200))`
  ),
}

/** userId -> the sockets that person currently has open (phone and laptop both). */
const sessions = new Map()

/** callId -> a ringing invitation that hasn't been answered yet. */
const calls = new Map()
const RING_MS = 45_000

const recoveryKey = () => randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()

function ensureUser(id, name, avatar) {
  let u = q.user.get(id)
  if (!u) {
    u = {
      id,
      code: newUserCode(new Set(q.codes.all().map((r) => r.code))),
      key: recoveryKey(),
      name: String(name || 'Guest').slice(0, 24),
      avatar: avatar || null,
      seen: Date.now(),
    }
    q.addUser.run(u.id, u.code, u.key, u.name, u.avatar, u.seen)
    return u
  }
  const nextName = name ? String(name).slice(0, 24) : u.name
  const nextAvatar = avatar === undefined ? u.avatar : avatar
  q.touchUser.run(nextName, nextAvatar, Date.now(), id)
  return { ...u, name: nextName, avatar: nextAvatar, seen: Date.now() }
}

/** Which party someone is actually sitting in, so a friend can walk into it. */
function partyOf(uid) {
  for (const r of rooms.values()) {
    const m = r.members.get(uid)
    if (m && m.approved && m.online) return r.code
  }
  return null
}

/**
 * Everyone's current party in one pass.
 *
 * Asking `partyOf` per friend meant walking every room for every name in every
 * list, and one person connecting rebuilds the list of everyone who knows them —
 * so the work went up with friends × friends × rooms. Built once and handed
 * down instead.
 */
function partyIndex() {
  const where = new Map()
  for (const r of rooms.values()) {
    for (const m of r.members.values()) {
      if (m.approved && m.online) where.set(m.id, r.code)
    }
  }
  return where
}

const publicUser = (u) => u && { id: u.id, code: u.code, name: u.name, avatar: u.avatar }

function friendsOf(id, where = partyIndex()) {
  const out = []
  for (const l of q.links.all(id, id)) {
    const otherId = l.a === id ? l.b : l.a
    const u = q.user.get(otherId)
    if (!u) continue
    const last = q.lastDm.get(l.pair)
    out.push({
      ...publicUser(u),
      accepted: !!l.accepted,
      // Who is waiting on whom — the UI shows an Accept button for one and a
      // "sent" label for the other.
      incoming: !l.accepted && l.asked !== id,
      outgoing: !l.accepted && l.asked === id,
      online: sessions.has(otherId),
      party: where.get(otherId) || null,
      seen: u.seen,
      last: last ? { text: last.text, at: last.at, mine: last.fromId === id } : null,
      // The running score at Stack, turned round to this person's point of view
      // so neither side has to work out which of them is "a".
      record: {
        mine: (l.a === id ? l.winsA : l.winsB) || 0,
        theirs: (l.a === id ? l.winsB : l.winsA) || 0,
        draws: l.draws || 0,
      },
    })
  }
  return out.sort((x, y) => (y.online ? 1 : 0) - (x.online ? 1 : 0) || x.name.localeCompare(y.name))
}

function pushFriends(id, where) {
  const socks = sessions.get(id)
  if (!socks) return
  const friends = friendsOf(id, where)
  for (const s of socks) send(s, { type: 'friends', friends })
}

/** Anything that changes how this person looks to others: presence, party, name. */
function pokeFriends(id) {
  const where = partyIndex() // one pass, shared by every list we're about to build
  pushFriends(id, where)
  for (const l of q.links.all(id, id)) pushFriends(l.a === id ? l.b : l.a, where)
}

/** Deliver to every device someone has open. Returns whether anyone was there. */
function toUser(id, msg) {
  const socks = sessions.get(id)
  if (!socks?.size) return false
  for (const s of socks) send(s, msg)
  return true
}

const areFriends = (a, b) => {
  const l = q.link.get(pairKey(a, b))
  return !!l?.accepted
}

/**
 * Someone a host has personally called or invited shouldn't then have to queue
 * at the door — the host already said yes by ringing them. Only a host's word
 * counts, so an ordinary member inviting a friend still puts them in the queue.
 */
function expectGuest(r, userId, byId) {
  const by = r.members.get(byId)
  if (!by || (r.ownerId !== byId && !by.coHost)) return
  ;(r.expected ||= new Set()).add(userId)
}

/**
 * A head-to-head round of Stack, started from a private chat. One attempt each,
 * highest tower wins. Held in memory only — nobody needs yesterday's game back.
 */
const matches = new Map()
const MATCH_TTL_MS = 15 * 60_000

function endMatch(matchId, reason) {
  const g = matches.get(matchId)
  if (!g) return
  clearTimeout(g.timer)
  matches.delete(matchId)
  toUser(g.a, { type: 'gameend', matchId, reason })
  toUser(g.b, { type: 'gameend', matchId, reason })
}

function endCall(callId, reason) {
  const c = calls.get(callId)
  if (!c) return
  clearTimeout(c.timer)
  calls.delete(callId)
  // A call nobody picked up is worth a line in the conversation — it's the only
  // place they'd think to look, and it survives the phone being off.
  if (reason === 'missed' || reason === 'gone') noteMissed(c.from, c.to)
  toUser(c.from, { type: 'callend', callId, reason })
  toUser(c.to, { type: 'callend', callId, reason })
}

function noteMissed(from, to) {
  const pair = pairKey(from, to)
  const msg = { id: randomUUID(), pair, fromId: from, text: 'Missed call', at: Date.now(), kind: 'missed' }
  q.addDm.run(msg.id, pair, msg.fromId, msg.text, msg.at, msg.kind)
  q.trimDms.run(pair, pair)
  const out = { type: 'dm', msg: { ...msg, from } }
  toUser(from, { ...out, with: to })
  toUser(to, { ...out, with: from })
  pushFriends(from)
  pushFriends(to)
}

/** A ring that arrived while they were away, handed over the moment they appear. */
function deliverHeldCalls(userId) {
  for (const [callId, c] of calls) {
    if (c.to !== userId) continue
    toUser(userId, { type: 'ring', callId, from: publicUser(q.user.get(c.from)), code: c.code })
  }
}

/* ------------------------------------------------------------- room clock */

// One timer for every room. Advances the clock, enforces auto-pause, hands over the crown.
setInterval(() => {
  const now = Date.now()
  for (const r of rooms.values()) {
    // Let go of seats belonging to people who are not coming back.
    for (const m of r.members.values()) {
      if (m.online || !m.leftAt || now - m.leftAt < MEMBER_TTL_MS) continue
      if (m.id === r.ownerId && !nextOwner([...r.members.values()], r.ownerId)) continue
      r.members.delete(m.id)
    }

    if (!online(r).length) {
      if (now - (r.emptyAt ||= now) > ROOM_TTL_MS) destroy(r)
      continue
    }
    r.emptyAt = null

    if (r.phase === 'playing' && !r.paused) {
      r.t += (now - r.lastTick) / 1000
      // Stop at the end instead of counting into empty space. Matters most for
      // music, where a track runs out every three minutes.
      if (r.duration && r.t >= r.duration) {
        r.t = r.duration
        r.paused = true
        r.pausedBy = r.ownerId
        r.behindTicks = 0
      }
      // Every stream dips for a moment. Stopping the film for a dip is worse
      // than the dip, so someone has to be genuinely out of video for a few
      // seconds running before the room waits for them.
      r.behindTicks = holdingUp([...r.members.values()], r.t, BUF.low).length
        ? (r.behindTicks || 0) + 1
        : 0
      if (r.behindTicks >= 3) {
        r.paused = true
        r.pausedBy = null
        r.behindTicks = 0
      }
    } else if (r.phase === 'playing' && r.paused && r.pausedBy === null) {
      // Auto-paused. Release only once everyone has a real cushion again, not
      // the moment they scrape past the line we stopped at. Nothing is said in
      // chat about any of this — the room already shows who it is waiting for,
      // and a line per transition turned a shaky connection into a wall of text.
      if (!holdingUp([...r.members.values()], r.t, BUF.resume).length) {
        r.paused = false
        r.behindTicks = 0
      }
    }
    r.lastTick = now

    const owner = r.members.get(r.ownerId)
    if (owner && !owner.online) {
      if (!r.ownerGoneAt) {
        r.ownerGoneAt = now
        r.paused = true
        r.pausedBy = r.ownerId
      } else if (!r.ownerSaid && now - r.ownerGoneAt > 5000) {
        // Only once they've actually gone. Refreshing a page is a two-second
        // round trip, and announcing it every time filled the chat with
        // "dropped — paused / resumed" for something nobody saw happen.
        r.ownerSaid = true
        say(r, `${owner.name} dropped — paused`)
      } else if (now - r.ownerGoneAt > OWNER_GRACE_MS) {
        const next = nextOwner([...r.members.values()], r.ownerId)
        if (next) {
          r.ownerId = next
          r.ownerGoneAt = null
          r.ownerSaid = false
          r.paused = true
          say(r, `${r.members.get(next).name} is the owner now`)
        }
      }
    } else if (owner?.online) { r.ownerGoneAt = null; r.ownerSaid = false }

    pushState(r)
  }
}, 1000)

/* -------------------------------------------------------------- countdown */

/**
 * Ready check -> everyone has video in hand -> 3, 2, 1.
 *
 * The wait for buffers is the whole point: starting the film the instant the
 * last person taps Ready means five players all begin with nothing downloaded,
 * all starve at once, and the room spends the first minute stuttering. Waiting
 * once here is what buys a clean start.
 */
function startCountdown(r) {
  if (r.countingDown) return
  r.countingDown = true
  let n = 3
  let patience = 30 // seconds of buffering we'll tolerate before starting anyway

  const tick = () => {
    if (!rooms.has(r.code) || r.phase === 'idle') { r.countingDown = false; return }

    if (patience-- > 0 && holdingUp([...r.members.values()], r.t, BUF.start).length) {
      // Hold, and *come back*. This used to return without rescheduling, which
      // stranded the party on "Starting…" with nothing left to wake it up.
      // Sitting in 'ready' keeps the card on screen, and it already names who
      // everyone is waiting for.
      r.phase = 'ready'
      pushState(r)
      return setTimeout(tick, 1000)
    }

    r.phase = 'countdown'
    broadcast(r, { type: 'countdown', n })
    if (n === 0) {
      r.phase = 'playing'
      r.paused = false
      r.pausedBy = null
      r.behindTicks = 0
      r.lastTick = Date.now()
      r.countingDown = false
      return pushState(r)
    }
    n--
    pushState(r)
    setTimeout(tick, 1000)
  }
  tick()
}

/** Begin the moment nobody is still un-ready — including the owner, who `start` readies. */
function maybeStart(r) {
  if (r.phase !== 'ready') return pushState(r)
  const waiting = [...r.members.values()].filter((m) => m.online && m.approved && !m.ready)
  if (waiting.length) return pushState(r)
  startCountdown(r)
}

/* ---------------------------------------------------------- media source */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const probeCache = new Map() // host -> plays directly in a browser?

const EMBED_NAME = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' }

/**
 * Shortened share links. The SoundCloud and Spotify apps' share buttons hand out
 * a URL with no artist, track or id in it — only a redirect — so the parsers
 * have nothing to read and what someone just copied gets rejected. Following it
 * once is the whole fix.
 */
function isShortLink(url) {
  return /^https?:\/\/(on\.soundcloud\.com|snd\.sc|spotify\.link)\//i.test(String(url || '').trim())
}

async function expandLink(url) {
  try {
    // HEAD, because these are redirect stubs and the body is never wanted — and
    // on a timer, because somebody pasting a link should not be able to hang the
    // request behind a host that never answers.
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(4000),
    })
    return r.url || url
  } catch {
    return url
  }
}

/** The file's own name, when the host will tell us — it usually carries "720p". */
async function describeFile(url) {
  const id = parsePixeldrain(url)
  if (id) {
    try {
      const r = await fetch(`https://pixeldrain.com/api/file/${id}/info`, { headers: { 'User-Agent': UA } })
      if (r.ok) return (await r.json()).name || ''
    } catch {}
  }
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { return '' }
}

/**
 * PixelDrain (and friends) refuse cross-site playback: the browser always sends
 * `Sec-Fetch-Site: cross-site` and JS cannot remove it, so <video src=pixeldrain>
 * gets 403 hotlink_detected. Node's fetch sends no such header, so streaming
 * through us works. Probe first — a host that allows direct playback should keep
 * it, because then the bytes never touch this server.
 */
async function chooseSource(direct) {
  const host = new URL(direct).host
  if (!probeCache.has(host)) {
    let ok = false
    try {
      const r = await fetch(direct, {
        headers: {
          Range: 'bytes=0-1', 'User-Agent': UA,
          'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'video',
        },
      })
      ok = r.ok || r.status === 206
      r.body?.cancel()
    } catch { ok = false }
    probeCache.set(host, ok)
    console.log(`source probe: ${host} ${ok ? 'plays directly' : 'blocks hotlinks — proxying'}`)
  }
  return probeCache.get(host)
    ? { play: direct, proxied: false }
    : { play: `/stream/${Buffer.from(direct).toString('base64url')}`, proxied: true }
}

/* ------------------------------------------------------------------ http */

const app = Fastify({ bodyLimit: 2 << 20 })

/**
 * The Android app is a WebView served from capacitor://localhost, so every call
 * it makes to this server is cross-origin. Nothing here is user-specific or
 * cookie-authenticated — a party code is the only key — so a blanket allow is
 * the honest setting rather than a list of origins to keep in sync.
 */
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return
  reply.header('access-control-allow-origin', '*')
  reply.header('access-control-allow-headers', 'content-type')
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') return reply.code(204).send()
})
app.register(fstatic, { root: path.join(HERE, 'web', 'dist') })
app.register(fstatic, { root: AVATARS, prefix: '/avatars/', decorateReply: false })

// Avatars arrive as a downscaled data URL — no multipart, no object storage.
async function uploadAvatar(req, reply) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.dataUrl || '')
  if (!m) return reply.code(400).send({ error: 'bad image' })
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 300_000) return reply.code(413).send({ error: 'too big' })
  const name = `${randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`
  await fs.promises.writeFile(path.join(AVATARS, name), buf)
  return { url: `/avatars/${name}` }
}
app.post('/api/avatar', uploadAvatar)

// Range-passthrough stream. Only URLs that are a live room's source are reachable,
// so this can't be used as an open proxy.
app.get('/stream/:b64', async (req, reply) => {
  let target
  try { target = Buffer.from(req.params.b64, 'base64url').toString() } catch { return reply.code(400).send() }
  // Only files a live room is actually playing. Checking `origin` alone would
  // also match a YouTube page URL and turn this into a fetch-anything proxy.
  const servable = [...rooms.values()].some((r) =>
    (r.sources || []).some((x) => x.kind === 'file' && x.origin === target))
  if (!servable) return reply.code(403).send({ error: 'not a live source' })

  // A <video> abandons range requests constantly (pause, seek, buffer-ahead).
  // Without this the upstream fetch to the host lives on, leaking a connection
  // per abandoned request until the host starts refusing us.
  const ac = new AbortController()
  req.raw.on('close', () => ac.abort())

  let upstream
  try {
    upstream = await fetch(target, {
      headers: { 'User-Agent': UA, ...(req.headers.range ? { Range: req.headers.range } : {}) },
      signal: ac.signal,
    })
  } catch {
    if (!ac.signal.aborted) return reply.code(502).send({ error: 'upstream unreachable' })
    return
  }

  reply.code(upstream.status)
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h)
    if (v) reply.header(h, v)
  }
  // The bytes behind a file id never change, so let the browser keep the ranges
  // it has already pulled. Without this, every pause, every seek backwards and
  // every re-buffer dragged the same bytes through this server again.
  reply.header('cache-control', 'public, max-age=86400')
  if (!upstream.body) return reply.send(null)

  const body = Readable.fromWeb(upstream.body)
  body.on('error', () => {}) // client hung up mid-chunk: normal, not a crash
  return reply.send(body)
})

/* ---------------------------------------------------------------- API v1 */
// Small, stable surface for the Android app. Everything else it needs rides on
// the same websocket the web client uses.

app.get('/api/v1/health', async () => ({
  ok: true,
  service: 'razzy',
  parties: rooms.size,
  ws: '/ws',
}))

/** Does this code exist, and can another person still get in? */
app.get('/api/v1/party/:code', async (req, reply) => {
  const r = rooms.get(String(req.params.code).toUpperCase())
  if (!r) return reply.code(404).send({ error: 'no such party' })
  return {
    code: r.code,
    members: seats(r),
    cap: r.cap,
    full: seats(r) >= r.cap,
    phase: r.phase,
    playing: r.phase === 'playing' && !r.paused,
    sources: (r.sources || []).map((s) => ({ id: s.id, kind: s.kind, label: s.label })),
  }
})

/** What would this link turn into? Lets the app validate before sending it. */
app.get('/api/v1/resolve', async (req, reply) => {
  const url = req.query?.url || ''
  // Same courtesy as the socket path: chase a share-button link before refusing it.
  const src = resolveSource(url) || (isShortLink(url) ? resolveSource(await expandLink(url)) : null)
  if (!src) return reply.code(400).send({ error: 'unsupported link' })
  return { kind: src.kind, origin: src.origin }
})

app.post('/api/v1/avatar', uploadAvatar)

app.get('/api/party/:code', async (req, reply) => {
  const r = rooms.get(String(req.params.code).toUpperCase())
  if (!r) return reply.code(404).send({ error: 'no such party' })
  return { code: r.code, full: seats(r) >= r.cap, phase: r.phase }
})

// SPA fallback — except under /api, where handing a client index.html for a
// typo'd endpoint turns a clear 404 into "Unexpected token '<'".
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'no such endpoint' })
  reply.sendFile('index.html')
})

/* -------------------------------------------------------------------- ws */

const wss = new WebSocketServer({ noServer: true })

app.server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  let room = null
  let me = null
  let who = null // the person on the other end, independent of any party

  const fail = (msg) => send(ws, { type: 'error', error: msg })
  const isOwner = () => room && me && room.ownerId === me.id
  // Co-hosts share every day-to-day control. Only the owner appoints them,
  // holds the crown, and is the one the room can't run without.
  const isHost = () => isOwner() || (room && me && !!me.coHost && me.approved)

  const attach = (r, member) => {
    const stale = member.ws
    room = r
    me = member
    member.ws = ws
    member.online = true
    member.leftAt = null
    member.lastPong = Date.now()
    // Two live sockets for one person (a reconnect, a second tab) — drop the
    // older one rather than leaving it to time out and report us offline.
    if (stale && stale !== ws) { try { stale.close() } catch {} }
    send(ws, { type: 'joined', you: member.id, room: publicRoom(r), chat: r.chat })
    // Friends see which party you're in, so it has to be refreshed on the way in.
    if (who) pokeFriends(who.id)
  }

  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }

    /* --- lobby ------------------------------------------------------- */
    // also fires before joining
    if (m.type === 'pong') {
      if (me) { me.ping = Date.now() - m.ts; me.lastPong = Date.now() }
      return
    }

    /* --- people ------------------------------------------------------ */

    /**
     * Sent by every client the moment it connects, party or no party. This is
     * what makes presence, friend requests and calls reach someone sitting in
     * the lobby — previously the server didn't know a socket existed until it
     * was in a room.
     */
    if (m.type === 'hello') {
      if (!m.id) return
      who = ensureUser(m.id, m.name, m.avatar)
      if (!sessions.has(who.id)) sessions.set(who.id, new Set())
      sessions.get(who.id).add(ws)
      send(ws, { type: 'me', user: { ...publicUser(who), key: who.key } })
      pokeFriends(who.id)
      deliverHeldCalls(who.id) // a ring that came while they were away
      return
    }

    /** Reclaim an identity on a new device: the public code plus the private key. */
    if (m.type === 'restore') {
      const u = q.userByCode.get(String(m.code || '').toUpperCase())
      if (!u || u.key !== String(m.key || '').toUpperCase()) return fail('That code and key do not match')
      send(ws, { type: 'restored', user: { ...publicUser(u), key: u.key } })
      return
    }

    if (!who && m.type?.startsWith('friend')) return fail('not signed in')

    if (m.type === 'friendAdd') {
      const target = q.userByCode.get(String(m.code || '').toUpperCase().replace(/[^A-Z]/g, ''))
      if (!target) return fail('No one has that code')
      if (target.id === who.id) return fail('That is your own code')
      const pair = pairKey(who.id, target.id)
      const existing = q.link.get(pair)
      if (existing?.accepted) return fail('Already friends')
      if (existing) {
        // They asked first and we just asked back — treat that as accepting.
        if (existing.asked !== who.id) q.acceptLink.run(pair)
        else return fail('Already asked — waiting for them')
      } else {
        const [a, b] = [who.id, target.id].sort()
        q.addLink.run(pair, a, b, who.id, Date.now())
      }
      toUser(target.id, { type: 'friendreq', from: publicUser(who) })
      pokeFriends(who.id)
      return
    }

    if (m.type === 'friendAccept') {
      const pair = pairKey(who.id, String(m.id || ''))
      const l = q.link.get(pair)
      if (!l || l.accepted || l.asked === who.id) return
      q.acceptLink.run(pair)
      toUser(m.id, { type: 'friendok', from: publicUser(who) })
      pokeFriends(who.id)
      return
    }

    if (m.type === 'friendRemove') {
      const other = String(m.id || '')
      q.dropLink.run(pairKey(who.id, other))
      pokeFriends(who.id)
      pushFriends(other)
      return
    }

    if (m.type === 'dm' && who) {
      const to = String(m.id || '')
      if (!areFriends(who.id, to)) return fail('You can only message friends')
      const text = String(m.text || '').slice(0, MAX_MSG).trim()
      if (!text) return
      const pair = pairKey(who.id, to)
      const msg = { id: randomUUID(), pair, fromId: who.id, text, at: Date.now(), kind: 'user' }
      q.addDm.run(msg.id, pair, msg.fromId, msg.text, msg.at, msg.kind)
      q.trimDms.run(pair, pair)
      const out = { type: 'dm', with: to, msg: { ...msg, from: who.id, name: who.name } }
      send(ws, out)
      toUser(to, { type: 'dm', with: who.id, msg: { ...msg, from: who.id, name: who.name } })
      pushFriends(who.id)
      pushFriends(to)
      return
    }

    if (m.type === 'dmHistory' && who) {
      const to = String(m.id || '')
      if (!areFriends(who.id, to)) return
      const rows = q.dmPage.all(pairKey(who.id, to)).reverse()
      return send(ws, { type: 'dms', with: to, msgs: rows.map((r) => ({ ...r, from: r.fromId })) })
    }

    /** A quiet nudge: "come watch this", no ringing. */
    if (m.type === 'invite' && who) {
      const to = String(m.id || '')
      if (!areFriends(who.id, to)) return fail('You can only invite friends')
      const code = partyOf(who.id)
      if (!code) return fail('Start a party first')
      const r = rooms.get(code)
      if (r) expectGuest(r, to, who.id)
      if (!toUser(to, { type: 'invite', from: publicUser(who), code })) return fail('They are offline')
      return
    }

    /**
     * A call. There is no audio anywhere in this — the point is the ringing:
     * answering drops you straight into the caller's party, which is a much
     * faster way to get someone watching than typing a code at them.
     */
    if (m.type === 'call' && who) {
      const to = String(m.id || '')
      if (!areFriends(who.id, to)) return fail('You can only call friends')
      const code = partyOf(who.id)
      if (!code) return fail('Start a party first')
      for (const [id, c] of calls) if (c.from === who.id && c.to === to) endCall(id, 'cancelled')
      const callId = randomUUID()
      const call = { from: who.id, to, code, at: Date.now() }
      call.timer = setTimeout(() => endCall(callId, 'missed'), RING_MS)
      calls.set(callId, call)

      // Ring them if they're there. If they aren't, hold it rather than refusing
      // — someone whose phone is in a pocket is exactly who you want to call, and
      // the ring is delivered the moment they open the app. If it runs out first
      // it becomes a missed call in the conversation, which is where they'd look.
      const reached = toUser(to, { type: 'ring', callId, from: publicUser(who), code })
      send(ws, { type: 'calling', callId, to, waiting: !reached })
      return
    }

    if (m.type === 'callAnswer' && who) {
      const c = calls.get(String(m.callId || ''))
      if (!c || c.to !== who.id) return
      clearTimeout(c.timer)
      calls.delete(m.callId)
      const r = rooms.get(c.code)
      if (r) expectGuest(r, who.id, c.from)
      toUser(c.from, { type: 'callend', callId: m.callId, reason: 'answered' })
      // The answering client walks itself into the party with this.
      return send(ws, { type: 'calljoin', callId: m.callId, code: c.code })
    }

    if ((m.type === 'callDecline' || m.type === 'callCancel') && who) {
      const c = calls.get(String(m.callId || ''))
      if (!c || (c.to !== who.id && c.from !== who.id)) return
      return endCall(String(m.callId), m.type === 'callCancel' ? 'cancelled' : 'declined')
    }

    /* --- a game between two friends ---------------------------------- */

    if (m.type === 'challenge' && who) {
      const to = String(m.id || '')
      if (!areFriends(who.id, to)) return fail('You can only challenge friends')
      // One at a time between any two people, or scores land in the wrong game.
      for (const [id, g] of matches) {
        if ((g.a === who.id && g.b === to) || (g.a === to && g.b === who.id)) endMatch(id, 'cancelled')
      }
      const matchId = randomUUID()
      matches.set(matchId, {
        a: who.id, b: to, scores: {},
        timer: setTimeout(() => endMatch(matchId, 'expired'), MATCH_TTL_MS),
      })
      if (!toUser(to, { type: 'challenge', matchId, from: publicUser(who) })) {
        endMatch(matchId, 'offline')
        return fail('They are offline')
      }
      return send(ws, { type: 'challenged', matchId, to })
    }

    if (m.type === 'challengeAccept' && who) {
      const matchId = String(m.matchId || '')
      const g = matches.get(matchId)
      if (!g || g.b !== who.id) return
      const a = q.user.get(g.a)
      const b = q.user.get(g.b)
      toUser(g.a, { type: 'gamestart', matchId, opponent: publicUser(b) })
      toUser(g.b, { type: 'gamestart', matchId, opponent: publicUser(a) })
      return
    }

    if ((m.type === 'challengeDecline' || m.type === 'challengeCancel') && who) {
      const g = matches.get(String(m.matchId || ''))
      if (!g || (g.a !== who.id && g.b !== who.id)) return
      return endMatch(String(m.matchId), m.type === 'challengeCancel' ? 'cancelled' : 'declined')
    }

    if (m.type === 'gameScore' && who) {
      const matchId = String(m.matchId || '')
      const g = matches.get(matchId)
      if (!g || (g.a !== who.id && g.b !== who.id)) return
      // First tower counts. A second run would just be picking your best of many.
      if (g.scores[who.id] != null) return
      g.scores[who.id] = Math.max(0, Math.min(99_999, Math.floor(Number(m.score) || 0)))

      const done = g.scores[g.a] != null && g.scores[g.b] != null
      const news = { type: done ? 'gameresult' : 'gamescore', matchId, scores: g.scores }
      if (done) {
        const [sa, sb] = [g.scores[g.a], g.scores[g.b]]
        news.winner = sa === sb ? null : sa > sb ? g.a : g.b
        clearTimeout(g.timer)
        matches.delete(matchId)

        // The running score outlives the match, so it goes in the database.
        const pair = pairKey(g.a, g.b)
        const link = q.link.get(pair)
        if (link) {
          if (news.winner == null) q.drawn.run(pair)
          else if (news.winner === link.a) q.winA.run(pair)
          else q.winB.run(pair)
        }
      }
      toUser(g.a, news)
      toUser(g.b, news)
      if (done) { pushFriends(g.a); pushFriends(g.b) }
      return
    }

    if (m.type === 'create') {
      const cap = Math.min(50, Math.max(2, Number(m.cap) || 6))
      const code = newCode(new Set(rooms.keys()))
      const id = m.id || randomUUID()
      const r = {
        code, cap, ownerId: id, source: null, phase: 'idle', t: 0, paused: true, pausedBy: null,
        members: new Map(), chat: [], lastTick: Date.now(), ownerGoneAt: null, emptyAt: null,
      }
      rooms.set(code, r)
      const member = { id, name: String(m.name || 'Host').slice(0, 24), avatar: m.avatar || null, approved: true, online: true, joinedAt: Date.now(), ws: null }
      r.members.set(id, member)
      attach(r, member)
      say(r, `Party ${code} created`)
      return pushState(r)
    }

    if (m.type === 'join') {
      const r = rooms.get(String(m.code || '').toUpperCase())
      if (!r) return fail('No party with that code')

      const known = m.id && r.members.get(m.id)
      if (known) { attach(r, known); return pushState(r) } // rejoin keeps your seat

      if (seats(r) >= r.cap) return fail('Party is full')
      const id = m.id || randomUUID()
      // A host who called or invited this person has already let them in.
      const welcome = r.expected?.delete(id) || false
      const member = {
        id, name: String(m.name || 'Guest').slice(0, 24), avatar: m.avatar || null,
        approved: welcome, online: true, joinedAt: Date.now(), ws: null,
      }
      r.members.set(id, member)
      attach(r, member)
      if (welcome) say(r, `${member.name} joined`)
      else {
        const owner = r.members.get(r.ownerId)
        send(owner?.ws, { type: 'joinreq', id, name: member.name, avatar: member.avatar })
      }
      return pushState(r)
    }

    if (!room || !me) return fail('not in a party')

    /* --- owner ------------------------------------------------------- */
    if (m.type === 'approve' && isHost()) {
      const t = room.members.get(m.id)
      if (!t) return
      if (m.ok) {
        t.approved = true
        say(room, `${t.name} joined`)
      } else {
        send(t.ws, { type: 'declined' })
        room.members.delete(m.id)
      }
      return pushState(room)
    }

    if (m.type === 'kick' && isHost() && m.id !== room.ownerId) {
      const t = room.members.get(m.id)
      if (!t) return
      // A co-host can clear out troublemakers but can't turn on their peers.
      if (t.coHost && !isOwner()) return fail('Only the host can remove a co-host')
      send(t.ws, { type: 'declined' })
      t.ws?.close()
      room.members.delete(m.id)
      say(room, `${t.name} was removed`)
      return pushState(room)
    }

    // Only the owner appoints co-hosts — otherwise a co-host could recruit more
    // co-hosts and the owner would lose control of their own party.
    if (m.type === 'cohost' && isOwner()) {
      const t = room.members.get(m.id)
      if (!t || !t.approved) return fail('They need to be in the party')
      if (t.id === room.ownerId) return fail('You already run this party')
      t.coHost = !!m.on
      say(room, t.coHost ? `${t.name} is a co-host now` : `${t.name} is no longer a co-host`)
      return pushState(room)
    }

    if (m.type === 'promote' && isOwner()) {
      const t = room.members.get(m.id)
      if (!t || !t.approved || !t.online) return fail('They need to be in the party')
      room.ownerId = t.id
      t.coHost = false // the crown outranks it; no need to hold both
      room.ownerGoneAt = null
      say(room, `${me.name} made ${t.name} the host`)
      return pushState(room)
    }

    // Leaving. The host can't just walk out — the party would sit paused with
    // nobody able to press play, so they have to hand the crown over first.
    if (m.type === 'leave') {
      const others = [...room.members.values()].filter((x) => x.approved && x.online && x.id !== me.id)
      if (isOwner() && others.length) return fail('Make someone else the host before you leave')

      const r = room
      const gone = me
      room = null
      me = null
      r.members.delete(gone.id)
      send(ws, { type: 'left' })
      if (who) pokeFriends(who.id) // they're out of that party now
      if (![...r.members.values()].some((x) => x.approved)) return destroy(r) // last one out
      say(r, `${gone.name} left`)
      return pushState(r)
    }

    if (m.type === 'skip' && isHost()) {
      const t = room.members.get(m.id)
      if (t) { t.skipped = true; say(room, `Skipped ${t.name}`) }
      return pushState(room)
    }

    // `add` appends another rendition of the same video (a 1080p next to the
    // 720p) instead of replacing it, so viewers can pick per their bandwidth.
    if ((m.type === 'source' || m.type === 'addQuality') && isHost()) {
      const r = room
      const add = m.type === 'addQuality'
      if (add && !r.sources?.length) return fail('Load a video first')

      const load = (url) => {
        const src = resolveSource(url)
        if (!src) return fail('Paste a YouTube, PixelDrain, SoundCloud or Spotify link — or a direct .mp4')

        const put = (source, proxied, label) => {
          const entry = { id: randomUUID(), kind: src.kind, source, origin: src.origin, proxied, label }
          if (add) {
            r.sources = [...(r.sources || []), entry]
            say(r, `Added a ${label} option`)
          } else {
            r.sources = [entry]
            r.phase = 'idle'
            r.t = 0
            r.paused = true
            r.pausedBy = null
            r.behindTicks = 0
            r.countingDown = false
            r.seekedAt = 0
            r.duration = 0
            for (const x of r.members.values()) { x.ready = false; x.skipped = false; x.t = 0; x.buf = null }
            say(r, src.kind === 'file'
              ? (proxied ? 'New video loaded (streaming through the server)' : 'New video loaded')
              : `Now playing from ${label}`)
          }
          pushState(r)
        }

        // Everything except a plain file plays in someone else's embed: no bytes
        // to carry, nothing to probe. Sending those down the file path had them
        // fetched and possibly routed through /stream, which would have served an
        // HTML page as video.
        if (src.kind !== 'file') return put(src.source, false, EMBED_NAME[src.kind])

        describeFile(src.source)
          .then((name) => qualityLabel(name || src.source, `Option ${(r.sources?.length || 0) + 1}`))
          .then((label) =>
            chooseSource(src.source).then(({ play, proxied }) => put(play, proxied, label)))
          .catch(() => fail('Could not reach that file'))
      }

      // The share button on a phone hands out a shortened link carrying nothing
      // but a redirect. Chase it rather than rejecting what someone just copied.
      if (!resolveSource(m.url) && isShortLink(m.url)) expandLink(m.url).then(load)
      else load(m.url)
      return
    }

    if (m.type === 'removeQuality' && isHost()) {
      const list = room.sources || []
      if (list.length < 2) return fail('That is the only version')
      room.sources = list.filter((s) => s.id !== m.id)
      say(room, 'Removed a quality option')
      return pushState(room)
    }

    if (m.type === 'start' && isHost()) {
      if (!room.sources?.length) return fail('Paste a link first')
      room.phase = 'ready'
      for (const x of room.members.values()) x.ready = false
      me.ready = true
      say(room, 'Ready check — tap Ready')
      return maybeStart(room) // a host watching alone shouldn't wait for anyone
    }

    /* --- anyone ------------------------------------------------------ */
    if (m.type === 'ready') {
      me.ready = true
      return maybeStart(room)
    }

    if (m.type === 'pause') { // anyone can stop the room
      room.paused = true
      room.pausedBy = me.id
      say(room, `${me.name} paused`)
      return pushState(room)
    }

    if (m.type === 'play') {
      if (room.phase !== 'playing') return
      if (room.pausedBy && room.pausedBy !== me.id && !isOwner()) return fail('Only the owner can override')
      room.paused = false
      room.pausedBy = null
      room.lastTick = Date.now()
      say(room, `${me.name} resumed`)
      return pushState(room)
    }

    if (m.type === 'seek' && isHost()) {
      room.t = Math.max(0, Number(m.t) || 0)
      room.lastTick = Date.now()
      room.seekedAt = Date.now() // the owner's player hasn't caught up yet
      return pushState(room)
    }

    // Owner's player is the truth; everyone else just reports where they are.
    if (m.type === 'tick') {
      // A null position means the player has one but doesn't know it yet — some
      // embeds won't say until they've played once. Recorded as a real zero it
      // looks like someone stuck at the start, and the room stops to wait for a
      // player that can only start once the room is moving.
      const t = m.t == null ? null : Math.max(0, Number(m.t) || 0)
      // Stored as null rather than left alone: a member object survives a
      // reconnect, so skipping the write would keep whatever stale position was
      // there — which is exactly the "stuck at the start" this avoids.
      // `holdingUp` reads `m.t ?? roomTime`, so null means "don't wait for me".
      me.t = t
      me.buf = Math.max(0, Number(m.buf) || 0)
      me.paused = !!m.paused
      me.focus = !!m.focus
      if (t !== null && isOwner() && !room.paused && room.phase === 'playing') {
        // Forwards only, and never straight after a seek. A player that has just
        // been reloaded or swapped for another quality reads 0 for a moment, and
        // taking that literally threw the entire room back to the start of the
        // film. If the owner really did jump backwards they used the scrubber,
        // which sets the clock itself.
        const fresh = Date.now() - (room.seekedAt || 0) > 1500
        if (fresh && t > room.t - 2) {
          room.t = t
          room.lastTick = Date.now()
        }
      }
      return
    }

    // Only the host's player is asked, and only once — everyone is watching the
    // same thing, and a viewer who mis-reports it would stop the room early.
    if (m.type === 'duration' && isHost()) {
      const d = Number(m.d) || 0
      if (d > 0) room.duration = d
      return
    }

    // Soundboard: one person taps, everyone hears it.
    if (m.type === 'sfx') {
      if (!me.approved) return
      const now = Date.now()
      if (now - (me.sfxAt || 0) < SFX_COOLDOWN_MS) return
      me.sfxAt = now
      return broadcast(room, {
        type: 'sfx',
        id: String(m.id || '').slice(0, 40),
        from: me.id,
        name: me.name,
      })
    }

    if (m.type === 'typing') { me.typingAt = m.on ? Date.now() : 0; return }

    if (m.type === 'chat') {
      if (!me.approved) return
      const text = String(m.text || '').slice(0, MAX_MSG).trim()
      if (!text) return
      me.typingAt = 0
      const msg = { id: randomUUID(), kind: 'user', from: me.id, name: me.name, avatar: me.avatar, text, at: Date.now() }
      room.chat.push(msg)
      if (room.chat.length > CHAT_KEEP) room.chat.shift()
      return broadcast(room, { type: 'chat', msg })
    }
  })

  // A phone that walks out of wifi leaves a half-open socket: no close event
  // ever arrives, so the member stays "online" forever and the room sits there
  // waiting for a ghost to finish buffering. Silence is the only tell.
  const ping = setInterval(() => {
    if (me && Date.now() - (me.lastPong || 0) > DEAD_SOCKET_MS) return ws.terminate()
    send(ws, { type: 'ping', ts: Date.now() })
  }, 3000)

  ws.on('close', () => {
    clearInterval(ping)

    // Presence is per-socket, not per-person: closing a laptop shouldn't show
    // you offline to your friends while your phone is still connected.
    if (who) {
      const socks = sessions.get(who.id)
      socks?.delete(ws)
      if (socks && !socks.size) sessions.delete(who.id)
      q.seenUser.run(Date.now(), who.id)
      for (const [id, c] of calls) if (c.from === who.id || c.to === who.id) endCall(id, 'gone')
      // Only if they've gone entirely — a second device staying open is fine.
      if (!sessions.has(who.id)) {
        for (const [id, g] of matches) if (g.a === who.id || g.b === who.id) endMatch(id, 'gone')
      }
      pokeFriends(who.id)
    }

    if (!room || !me) return
    // A reconnecting client usually lands its new socket *before* the old one's
    // close event arrives. Without this check the corpse of the old connection
    // immediately marks the live one offline.
    if (me.ws !== ws) return
    me.online = false
    me.ws = null
    me.ready = false
    me.buf = null
    me.typingAt = 0
    me.leftAt = Date.now()
    if (!me.approved) room.members.delete(me.id) // never approved, never existed
    pushState(room)
  })
})

const port = process.env.PORT || 3000
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`razzy on :${port}`))
