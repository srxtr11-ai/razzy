import Fastify from 'fastify'
import fstatic from '@fastify/static'
import { WebSocketServer } from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { BUF, newCode, parsePixeldrain, qualityLabel, resolveSource, holdingUp, nextOwner } from './lib.js'

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
  for (const m of r.members.values()) rmAvatar(m.avatar)
  rooms.delete(r.code)
  dropStmt.run(r.code)
}

function rmAvatar(url) {
  if (!url?.startsWith('/avatars/')) return
  fs.rm(path.join(AVATARS, path.basename(url)), { force: true }, () => {})
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
      rmAvatar(m.avatar)
      r.members.delete(m.id)
    }

    if (!online(r).length) {
      if (now - (r.emptyAt ||= now) > ROOM_TTL_MS) destroy(r)
      continue
    }
    r.emptyAt = null

    if (r.phase === 'playing' && !r.paused) {
      r.t += (now - r.lastTick) / 1000
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
        say(r, `${owner.name} dropped — paused`)
      } else if (now - r.ownerGoneAt > OWNER_GRACE_MS) {
        const next = nextOwner([...r.members.values()], r.ownerId)
        if (next) {
          r.ownerId = next
          r.ownerGoneAt = null
          r.paused = true
          say(r, `${r.members.get(next).name} is the owner now`)
        }
      }
    } else if (owner?.online) r.ownerGoneAt = null

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
  const src = resolveSource(req.query?.url || '')
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
      const member = {
        id, name: String(m.name || 'Guest').slice(0, 24), avatar: m.avatar || null,
        approved: false, online: true, joinedAt: Date.now(), ws: null,
      }
      r.members.set(id, member)
      attach(r, member)
      const owner = r.members.get(r.ownerId)
      send(owner?.ws, { type: 'joinreq', id, name: member.name, avatar: member.avatar })
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
        rmAvatar(t.avatar)
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
      rmAvatar(t.avatar)
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
      rmAvatar(gone.avatar)
      r.members.delete(gone.id)
      send(ws, { type: 'left' })
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
      const src = resolveSource(m.url)
      if (!src) return fail('Paste a YouTube link, a PixelDrain link, or a direct .mp4')
      const r = room
      const add = m.type === 'addQuality'
      if (add && !r.sources?.length) return fail('Load a video first')

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
          for (const x of r.members.values()) { x.ready = false; x.skipped = false; x.t = 0; x.buf = null }
          say(r, src.kind === 'youtube'
            ? 'New video loaded from YouTube'
            : proxied ? 'New video loaded (streaming through the server)' : 'New video loaded')
        }
        pushState(r)
      }

      // YouTube plays in its own embedded player: nothing to probe, no bytes to
      // carry, and its own quality levels are offered by the player itself.
      if (src.kind === 'youtube') return put(src.source, false, 'YouTube')

      describeFile(src.source)
        .then((name) => qualityLabel(name || src.source, `Option ${(r.sources?.length || 0) + 1}`))
        .then((label) =>
          chooseSource(src.source).then(({ play, proxied }) => put(play, proxied, label)))
        .catch(() => fail('Could not reach that file'))
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
      const t = Math.max(0, Number(m.t) || 0)
      me.t = t
      me.buf = Math.max(0, Number(m.buf) || 0)
      me.paused = !!m.paused
      me.focus = !!m.focus
      if (isOwner() && !room.paused && room.phase === 'playing') {
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
