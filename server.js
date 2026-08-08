import Fastify from 'fastify'
import fstatic from '@fastify/static'
import { WebSocketServer } from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { newCode, resolveSource, laggards, nextOwner } from './lib.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = process.env.DATA_DIR || path.join(HERE, 'data') // Railway volume mounts here
const AVATARS = path.join(DATA, 'avatars')
fs.mkdirSync(AVATARS, { recursive: true })

const OWNER_GRACE_MS = Number(process.env.OWNER_GRACE_MS) || 60_000 // crown passes after this
const ROOM_TTL_MS = 10 * 60_000 // empty room dies after this
const MAX_MSG = 500
const CHAT_KEEP = 200

/* ---------------------------------------------------------------- storage */

const db = new DatabaseSync(path.join(DATA, 'party.db'))
db.exec(`CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)`)
const saveStmt = db.prepare(`INSERT INTO rooms (code,data,updated) VALUES (?,?,?)
  ON CONFLICT(code) DO UPDATE SET data=excluded.data, updated=excluded.updated`)
const dropStmt = db.prepare(`DELETE FROM rooms WHERE code = ?`)

/** Everything except live sockets. Members come back as offline after a redeploy. */
const snapshot = (r) => ({
  code: r.code, cap: r.cap, ownerId: r.ownerId, source: r.source, origin: r.origin ?? null,
  proxied: !!r.proxied, phase: r.phase, t: r.t, paused: r.paused,
  members: [...r.members.values()].map(({ ws, ...m }) => ({ ...m, online: false, ready: false, buffering: false })),
})

const persist = (r) => saveStmt.run(r.code, JSON.stringify(snapshot(r)), Date.now())

/* ------------------------------------------------------------------ rooms */

/** code -> room. Live state; the db copy is only a redeploy parachute. */
const rooms = new Map()

for (const row of db.prepare(`SELECT data FROM rooms`).all()) {
  const s = JSON.parse(row.data)
  rooms.set(s.code, {
    ...s,
    paused: true,
    phase: s.phase === 'playing' ? 'playing' : 'idle',
    members: new Map(s.members.map((m) => [m.id, { ...m, ws: null }])),
    chat: [],
    ownerGoneAt: Date.now(),
    emptyAt: Date.now(),
  })
}

const online = (r) => [...r.members.values()].filter((m) => m.online)
const approved = (r) => [...r.members.values()].filter((m) => m.approved)

function publicRoom(r) {
  const waiting = laggards([...r.members.values()], r.t).map((m) => m.id)
  return {
    code: r.code, cap: r.cap, ownerId: r.ownerId, source: r.source, origin: r.origin ?? null,
    proxied: !!r.proxied,
    phase: r.phase, t: r.t, paused: r.paused, pausedBy: r.pausedBy || null, waiting,
    members: [...r.members.values()].map((m) => ({
      id: m.id, name: m.name, avatar: m.avatar, approved: m.approved, online: m.online,
      ready: !!m.ready, buffering: !!m.buffering, paused: !!m.paused, focus: !!m.focus,
      typing: !!m.typing, skipped: !!m.skipped, ping: m.ping ?? null, joinedAt: m.joinedAt,
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
    if (!online(r).length) {
      if (now - (r.emptyAt ||= now) > ROOM_TTL_MS) destroy(r)
      continue
    }
    r.emptyAt = null

    if (r.phase === 'playing' && !r.paused) {
      r.t += (now - r.lastTick) / 1000
      const behind = laggards([...r.members.values()], r.t)
      // Hysteresis: a single slow tick is normal streaming jitter. Only stop the
      // room if someone is still behind on the next tick, or the chat fills with
      // pause/resume spam every few seconds.
      if (behind.length) r.behindTicks = (r.behindTicks || 0) + 1
      else r.behindTicks = 0

      if (r.behindTicks >= 2) {
        r.paused = true
        r.pausedBy = null
        r.announcedWait = behind.map((m) => m.name).join(', ')
        say(r, `Waiting for ${r.announcedWait}…`)
      }
    } else if (r.phase === 'playing' && r.paused && r.pausedBy === null) {
      // auto-paused: resume the moment everyone has caught up
      if (!laggards([...r.members.values()], r.t).length) {
        r.paused = false
        r.behindTicks = 0
        if (r.announcedWait) { say(r, 'Everyone caught up — resuming'); r.announcedWait = null }
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

function startCountdown(r) {
  r.phase = 'countdown'
  let n = 3
  let patience = 20 // seconds of buffering we'll tolerate before starting anyway
  pushState(r)
  const tick = () => {
    // A straggler buffering mid-countdown restarts the wait rather than starting without them —
    // but never forever, or one dead connection freezes the party permanently.
    if (patience-- > 0 && laggards([...r.members.values()], r.t).length) {
      r.phase = 'ready'
      say(r, 'Still buffering — hold on')
      return pushState(r)
    }
    broadcast(r, { type: 'countdown', n })
    if (n === 0) {
      r.phase = 'playing'
      r.paused = false
      r.pausedBy = null
      r.lastTick = Date.now()
      return pushState(r)
    }
    n--
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
app.register(fstatic, { root: path.join(HERE, 'web', 'dist') })
app.register(fstatic, { root: AVATARS, prefix: '/avatars/', decorateReply: false })

// Avatars arrive as a downscaled data URL — no multipart, no object storage.
app.post('/api/avatar', async (req, reply) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.dataUrl || '')
  if (!m) return reply.code(400).send({ error: 'bad image' })
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 300_000) return reply.code(413).send({ error: 'too big' })
  const name = `${randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`
  await fs.promises.writeFile(path.join(AVATARS, name), buf)
  return { url: `/avatars/${name}` }
})

// Range-passthrough stream. Only URLs that are a live room's source are reachable,
// so this can't be used as an open proxy.
app.get('/stream/:b64', async (req, reply) => {
  let target
  try { target = Buffer.from(req.params.b64, 'base64url').toString() } catch { return reply.code(400).send() }
  if (![...rooms.values()].some((r) => r.origin === target)) return reply.code(403).send({ error: 'not a live source' })

  const upstream = await fetch(target, {
    headers: { 'User-Agent': UA, ...(req.headers.range ? { Range: req.headers.range } : {}) },
  })
  reply.code(upstream.status)
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h)
    if (v) reply.header(h, v)
  }
  reply.header('cache-control', 'no-store')
  return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null)
})

app.get('/api/party/:code', async (req, reply) => {
  const r = rooms.get(String(req.params.code).toUpperCase())
  if (!r) return reply.code(404).send({ error: 'no such party' })
  return { code: r.code, full: approved(r).length >= r.cap, phase: r.phase }
})

// SPA fallback
app.setNotFoundHandler((req, reply) => reply.sendFile('index.html'))

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

  const attach = (r, member) => {
    room = r
    me = member
    member.ws = ws
    member.online = true
    send(ws, { type: 'joined', you: member.id, room: publicRoom(r), chat: r.chat })
  }

  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }

    /* --- lobby ------------------------------------------------------- */
    if (m.type === 'pong') { if (me) me.ping = Date.now() - m.ts; return } // also fires before joining

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

      if (approved(r).length >= r.cap) return fail('Party is full')
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
    if (m.type === 'approve' && isOwner()) {
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

    if (m.type === 'kick' && isOwner() && m.id !== room.ownerId) {
      const t = room.members.get(m.id)
      if (!t) return
      send(t.ws, { type: 'declined' })
      t.ws?.close()
      rmAvatar(t.avatar)
      room.members.delete(m.id)
      say(room, `${t.name} was removed`)
      return pushState(room)
    }

    if (m.type === 'skip' && isOwner()) {
      const t = room.members.get(m.id)
      if (t) { t.skipped = true; say(room, `Skipped ${t.name}`) }
      return pushState(room)
    }

    if (m.type === 'source' && isOwner()) {
      const src = resolveSource(m.url)
      if (!src) return fail('Direct file links only (PixelDrain, .mp4)')
      const r = room
      r.origin = src.url // must be set before /stream will serve it
      chooseSource(src.url).then(({ play, proxied }) => {
        r.source = play
        r.proxied = proxied
        r.phase = 'idle'
        r.t = 0
        r.paused = true
        for (const x of r.members.values()) { x.ready = false; x.skipped = false; x.t = 0 }
        say(r, proxied ? 'New video loaded (streaming through the server)' : 'New video loaded')
        pushState(r)
      }).catch(() => fail('Could not reach that file'))
      return
    }

    if (m.type === 'start' && isOwner()) {
      if (!room.source) return fail('Paste a link first')
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

    if (m.type === 'seek' && isOwner()) {
      room.t = Math.max(0, Number(m.t) || 0)
      room.lastTick = Date.now()
      return pushState(room)
    }

    // Owner's player is the truth; everyone else just reports where they are.
    if (m.type === 'tick') {
      me.t = Number(m.t) || 0
      me.buffering = !!m.buffering
      me.paused = !!m.paused
      me.focus = !!m.focus
      if (isOwner() && !room.paused && room.phase === 'playing') {
        room.t = me.t
        room.lastTick = Date.now()
      }
      return
    }

    if (m.type === 'typing') { me.typing = !!m.on; return }

    if (m.type === 'chat') {
      if (!me.approved) return
      const text = String(m.text || '').slice(0, MAX_MSG).trim()
      if (!text) return
      me.typing = false
      const msg = { id: randomUUID(), kind: 'user', from: me.id, name: me.name, avatar: me.avatar, text, at: Date.now() }
      room.chat.push(msg)
      if (room.chat.length > CHAT_KEEP) room.chat.shift()
      return broadcast(room, { type: 'chat', msg })
    }
  })

  const ping = setInterval(() => send(ws, { type: 'ping', ts: Date.now() }), 3000)

  ws.on('close', () => {
    clearInterval(ping)
    if (!room || !me) return
    me.online = false
    me.ws = null
    me.ready = false
    me.buffering = false
    if (!me.approved) room.members.delete(me.id) // never approved, never existed
    pushState(room)
  })
})

const port = process.env.PORT || 3000
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`razzy on :${port}`))
