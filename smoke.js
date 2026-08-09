// End-to-end: boots the real server, runs a two-person party through create ->
// join request -> approve -> load -> ready check -> countdown -> playing -> chat.
// Run: node smoke.js
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'

// Ask the OS for a free port rather than hard-coding one — Windows reserves
// scattered ranges (Hyper-V etc.) and a fixed port hits EACCES at random.
const PORT = await new Promise((res, rej) => {
  const s = createServer()
  s.on('error', rej)
  s.listen(0, '0.0.0.0', () => {
    const { port } = s.address()
    s.close(() => res(port))
  })
})
const DATA = path.join(import.meta.dirname, '.smoke-data')
fs.rmSync(DATA, { recursive: true, force: true })

const server = spawn(process.execPath, ['server.js'], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT, DATA_DIR: DATA, OWNER_GRACE_MS: 2000, SEAT_HOLD_MS: 2000 },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const done = async (code) => {
  server.kill()
  await new Promise((r) => setTimeout(r, 300)) // let sqlite release the file on Windows
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  process.exit(code)
}
process.on('uncaughtException', (e) => { console.error(e); done(1) })

await new Promise((r) => server.stdout.on('data', (b) => String(b).includes('razzy on') && r()))

function client(label) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
  const seen = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', ts: m.ts }))
    seen.push(m)
  })
  return {
    label, ws, seen,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    // `fresh` ignores anything already buffered — state messages arrive every second,
    // so an old one will happily satisfy a predicate about a change that hasn't happened yet.
    wait: (pred, ms = 8000, fresh = false) =>
      new Promise((res, rej) => {
        const hit = fresh ? null : seen.find(pred)
        if (hit) return res(hit)
        const t = setTimeout(
          () => rej(new Error(`${label}: timed out after ${ms}ms waiting for ${pred}`)), ms)
        const on = (raw) => {
          const m = JSON.parse(raw)
          if (pred(m)) { clearTimeout(t); ws.off('message', on); res(m) }
        }
        ws.on('message', on)
      }),
    last: (type) => [...seen].reverse().find((m) => m.type === type),
  }
}

const host = client('host')
const guest = client('guest')
await Promise.all([host.ready, guest.ready])

// 0. a client sitting in the lobby must never be told off for keepalives
const idle = client('idle')
await idle.ready
await new Promise((r) => setTimeout(r, 3500)) // one ping cycle
assert.ok(!idle.seen.some((m) => m.type === 'error'), 'lobby keepalive is silent')
idle.ws.close()

// 1. create
host.send({ type: 'create', name: 'Host', cap: 4 })
const created = await host.wait((m) => m.type === 'joined')
const code = created.room.code
assert.equal(code.length, 3, 'party code is 3 letters')
console.log('· created party', code)

// 2. guest asks to join, host is notified, guest is not yet approved
guest.send({ type: 'join', code, name: 'Guest' })
const req = await host.wait((m) => m.type === 'joinreq')
assert.equal(req.name, 'Guest')
const guestJoined = await guest.wait((m) => m.type === 'joined')
assert.equal(guestJoined.room.members.find((m) => m.id === guestJoined.you).approved, false, 'waits at the door')
console.log('· join request reached the host')

// 3. guest cannot chat before approval
guest.send({ type: 'chat', text: 'let me in' })
await new Promise((r) => setTimeout(r, 300))
assert.ok(!host.seen.some((m) => m.type === 'chat' && m.msg.text === 'let me in'), 'unapproved cannot talk')

// 4. approve
host.send({ type: 'approve', id: req.id, ok: true })
await guest.wait((m) => m.type === 'state' && m.room.members.find((x) => x.id === guestJoined.you)?.approved)
console.log('· guest approved')

// 5. only the owner can load a source, and only direct files are accepted
guest.send({ type: 'source', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
await new Promise((r) => setTimeout(r, 200))
assert.equal(host.last('state').room.sources.length, 0, 'guest cannot set the source')

host.send({ type: 'source', url: 'https://www.youtube.com/watch?v=abc' })
await host.wait((m) => m.type === 'error')
host.send({ type: 'source', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
const withSrc = await guest.wait((m) => m.type === 'state' && m.room.sources.length, 15000)
const only = withSrc.room.sources[0]
assert.equal(only.origin, 'https://pixeldrain.com/api/file/GKBvQx7Y', 'pixeldrain link resolved')
assert.equal(only.label, '720p', 'quality label read from the file name')
// PixelDrain blocks cross-site playback, so the server must have chosen to stream it
assert.equal(only.proxied, true, 'hotlink-blocking host gets proxied')
assert.match(only.source, /^\/stream\//, 'client is pointed at our stream route')
console.log('· source resolved, hotlink block detected -> proxying')

// the stream route must actually return video bytes, and refuse anything not a live source
const ranged = await fetch(`http://localhost:${PORT}${only.source}`, { headers: { Range: 'bytes=0-999' } })
assert.equal(ranged.status, 206, 'range request passes through')
assert.equal(ranged.headers.get('content-type'), 'video/mp4', 'video content type preserved')
assert.equal((await ranged.arrayBuffer()).byteLength, 1000, 'exactly the requested bytes')
const openProxy = await fetch(`http://localhost:${PORT}/stream/${Buffer.from('https://example.com/evil.mp4').toString('base64url')}`)
assert.equal(openProxy.status, 403, 'not usable as an open proxy')
console.log('· stream route serves ranges and refuses foreign URLs')

// 6. ready check -> countdown -> playing
host.send({ type: 'start' })
await guest.wait((m) => m.type === 'state' && m.room.phase === 'ready')
host.send({ type: 'tick', t: 0, buf: 30 })
guest.send({ type: 'tick', t: 0, buf: 30 })
guest.send({ type: 'ready' })
const three = await guest.wait((m) => m.type === 'countdown')
assert.equal(three.n, 3, 'countdown starts at 3')
const playing = await guest.wait((m) => m.type === 'state' && m.room.phase === 'playing' && !m.room.paused, 10000)
assert.equal(playing.room.paused, false, 'room is playing')
console.log('· ready check + countdown -> playing')

// 7. the room clock advances
const t0 = playing.room.t
host.send({ type: 'tick', t: t0 + 2, buf: 30 })
await new Promise((r) => setTimeout(r, 1500))
assert.ok(host.last('state').room.t > t0, 'clock advanced')

// 8. anyone can pause
guest.send({ type: 'pause' })
const paused = await host.wait((m) => m.type === 'state' && m.room.paused, 8000, true)
assert.equal(paused.room.pausedBy, guestJoined.you, 'the room knows who paused')
console.log('· guest paused the room')

// 9. a straggler holds the room, and the owner can skip them
guest.send({ type: 'tick', t: 0, buf: 0 })
await new Promise((r) => setTimeout(r, 1400))
assert.ok(host.last('state').room.waiting.includes(guestJoined.you), 'buffering guest holds the room')
host.send({ type: 'skip', id: guestJoined.you })
await host.wait((m) => m.type === 'state' && !m.room.waiting.length, 8000, true)
console.log('· straggler detected, then skipped')

// 10. chat reaches everyone
guest.send({ type: 'chat', text: 'this is the funny part' })
const got = await host.wait((m) => m.type === 'chat' && m.msg.text === 'this is the funny part')
assert.equal(got.msg.name, 'Guest')
console.log('· chat delivered')

// 11. avatar upload round-trips to disk
const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const up = await fetch(`http://localhost:${PORT}/api/avatar`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: px }),
}).then((r) => r.json())
assert.ok(up.url.startsWith('/avatars/'), 'avatar stored')
assert.equal((await fetch(`http://localhost:${PORT}${up.url}`)).status, 200, 'avatar served back')
const bad = await fetch(`http://localhost:${PORT}/api/avatar`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: 'javascript:alert(1)' }),
})
assert.equal(bad.status, 400, 'non-image rejected')
console.log('· avatars upload, serve, and reject junk')

// 12. party is full
const extra = []
for (let i = 0; i < 2; i++) { // cap is 4 and host+guest already hold two seats
  const c = client('x' + i)
  await c.ready
  c.send({ type: 'join', code, name: 'X' + i })
  extra.push(c)
  const r = await host.wait((m) => m.type === 'joinreq' && m.name === 'X' + i)
  host.send({ type: 'approve', id: r.id, ok: true })
  await new Promise((res) => setTimeout(res, 120))
}
const full = client('full')
await full.ready
full.send({ type: 'join', code, name: 'TooMany' })
const err = await full.wait((m) => m.type === 'error')
assert.match(err.error, /full/i, 'cap enforced')
console.log('· member cap enforced')

// 13. owner drops -> room pauses -> crown passes to the longest-present member
host.ws.close()
const orphan = await guest.wait((m) => m.type === 'state' && m.room.paused, 8000, true)
assert.equal(orphan.room.ownerId, created.you, 'still the original owner during the grace period')
const crowned = await guest.wait((m) => m.type === 'state' && m.room.ownerId !== created.you, 10000, true)
assert.equal(crowned.room.ownerId, guestJoined.you, 'longest-present member takes the crown')
assert.equal(crowned.room.paused, true, 'stays paused for the new owner to resume')
console.log('· owner dropped -> paused -> crown transferred')

// 14. a host watching alone starts without waiting for a ready tap from anyone
const solo = client('solo')
await solo.ready
solo.send({ type: 'create', name: 'Solo', cap: 2 })
await solo.wait((m) => m.type === 'joined')
solo.send({ type: 'source', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
await solo.wait((m) => m.type === 'state' && m.room.sources.length, 15000)
solo.send({ type: 'start' })
const soloGo = await solo.wait((m) => m.type === 'state' && m.room.phase === 'playing', 15000)
assert.equal(soloGo.room.paused, false, 'solo host starts playing on its own')
console.log('· solo host starts without a second person')

// 15. the typing flag expires on its own — clients stop mid-word without saying so
guest.send({ type: 'typing', on: true })
await new Promise((r) => setTimeout(r, 1200))
assert.equal(guest.last('state').room.members.find((m) => m.id === guestJoined.you).typing, true, 'typing shows')
await new Promise((r) => setTimeout(r, 4200)) // past TYPING_TTL_MS, without a "stopped"
assert.equal(guest.last('state').room.members.find((m) => m.id === guestJoined.you).typing, false, 'typing expires by itself')
console.log('· typing indicator expires instead of sticking')

// 16. abandoned stream requests must not take the server down or leak upstream
const src = `http://localhost:${PORT}${only.source}`
for (let i = 0; i < 5; i++) {
  const ac = new AbortController()
  const res = await fetch(src, { signal: ac.signal })
  await res.body.getReader().read()
  ac.abort() // exactly what a <video> does on pause/seek
}
await new Promise((r) => setTimeout(r, 800))
assert.equal((await fetch(`http://localhost:${PORT}/api/party/${code}`)).status, 200, 'server survives abandoned streams')
console.log('· abandoned stream requests are cleaned up')

// 17. leaving: the host can't abandon a room that still has people in it
const p1 = client('p1')
const p2 = client('p2')
await Promise.all([p1.ready, p2.ready])
p1.send({ type: 'create', name: 'Owner', cap: 4 })
const p1j = await p1.wait((m) => m.type === 'joined')
const roomCode = p1j.room.code
p2.send({ type: 'join', code: roomCode, name: 'Second' })
const p2j = await p2.wait((m) => m.type === 'joined')
const rq = await p1.wait((m) => m.type === 'joinreq' && m.name === 'Second')
p1.send({ type: 'approve', id: rq.id, ok: true })
await p2.wait((m) => m.type === 'state' && m.room.members.find((x) => x.id === p2j.you)?.approved)

p1.send({ type: 'leave' })
const refused = await p1.wait((m) => m.type === 'error')
assert.match(refused.error, /host/i, 'host is stopped from leaving people behind')
assert.ok(!p1.seen.some((m) => m.type === 'left'), 'and did not leave')
console.log('· host cannot leave without handing over')

// 18. hand the crown over, then leaving works
p1.send({ type: 'promote', id: p2j.you })
const promoted = await p2.wait((m) => m.type === 'state' && m.room.ownerId === p2j.you, 8000, true)
assert.equal(promoted.room.ownerId, p2j.you, 'crown handed over on request')
p1.send({ type: 'leave' })
await p1.wait((m) => m.type === 'left')
const afterLeave = await p2.wait(
  (m) => m.type === 'state' && !m.room.members.some((x) => x.id === p1j.you), 8000, true)
assert.equal(afterLeave.room.members.length, 1, 'the leaver is gone')
assert.equal(afterLeave.room.ownerId, p2j.you, 'new host keeps the room')
console.log('· promote then leave works')

// 19. the last person out ends the party
p2.send({ type: 'leave' })
await p2.wait((m) => m.type === 'left')
await new Promise((r) => setTimeout(r, 400))
assert.equal((await fetch(`http://localhost:${PORT}/api/party/${roomCode}`)).status, 404, 'empty party is gone')
console.log('· last one out closes the party')

// 20. only the host may promote
const sneak = client('sneak')
await sneak.ready
sneak.send({ type: 'create', name: 'A', cap: 3 })
const sj = await sneak.wait((m) => m.type === 'joined')
const mate = client('mate')
await mate.ready
mate.send({ type: 'join', code: sj.room.code, name: 'B' })
const mj = await mate.wait((m) => m.type === 'joined')
const mr = await sneak.wait((m) => m.type === 'joinreq')
sneak.send({ type: 'approve', id: mr.id, ok: true })
await mate.wait((m) => m.type === 'state' && m.room.members.find((x) => x.id === mj.you)?.approved)
mate.send({ type: 'promote', id: mj.you }) // a guest crowning themselves
await new Promise((r) => setTimeout(r, 500))
assert.equal(mate.last('state').room.ownerId, sj.you, 'a guest cannot take the crown')
console.log('· only the host can hand over the crown')

// 21. youtube: accepted, never probed, never proxied
const ytc = client('yt')
await ytc.ready
ytc.send({ type: 'create', name: 'YT', cap: 2 })
await ytc.wait((m) => m.type === 'joined')
ytc.send({ type: 'source', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s' })
const ytState = await ytc.wait((m) => m.type === 'state' && m.room.sources.length, 10000)
assert.equal(ytState.room.sources[0].kind, 'youtube', 'recognised as a youtube source')
assert.equal(ytState.room.sources[0].source, 'dQw4w9WgXcQ', 'the client gets the video id, not a byte URL')
assert.equal(ytState.room.sources[0].proxied, false, 'youtube bytes never touch this server')
assert.ok(!ytState.room.sources[0].source.startsWith('/stream/'), 'not routed through the proxy')

// and the proxy refuses to fetch it even if someone asks directly
const ytProxy = await fetch(
  `http://localhost:${PORT}/stream/${Buffer.from('https://www.youtube.com/watch?v=dQw4w9WgXcQ').toString('base64url')}`)
assert.equal(ytProxy.status, 403, 'youtube cannot be pulled through the stream route')
console.log('· youtube accepted, embedded not proxied')

// 22. a file source in the same server still proxies — the two paths coexist
ytc.send({ type: 'source', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
const backToFile = await ytc.wait((m) => m.type === 'state' && m.room.sources[0]?.kind === 'file', 15000, true)
assert.equal(backToFile.room.sources[0].proxied, true, 'switching back to a file still proxies')
console.log('· switching between youtube and file sources works')

// 23. quality options: added, labelled, chosen per viewer, removed
const qa = client('qa')
const qb = client('qb')
await Promise.all([qa.ready, qb.ready])
qa.send({ type: 'create', name: 'QHost', cap: 3 })
const qaj = await qa.wait((m) => m.type === 'joined')
qb.send({ type: 'join', code: qaj.room.code, name: 'QGuest' })
const qbj = await qb.wait((m) => m.type === 'joined')
const qreq = await qa.wait((m) => m.type === 'joinreq')
qa.send({ type: 'approve', id: qreq.id, ok: true })
await qb.wait((m) => m.type === 'state' && m.room.members.find((x) => x.id === qbj.you)?.approved)

qa.send({ type: 'addQuality', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
await qa.wait((m) => m.type === 'error') // nothing loaded yet
qa.send({ type: 'source', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
await qa.wait((m) => m.type === 'state' && m.room.sources.length === 1, 15000)
qa.send({ type: 'addQuality', url: 'https://cdn.example.com/movie-1080p.mp4' })
const two = await qa.wait((m) => m.type === 'state' && m.room.sources.length === 2, 15000, true)
assert.deepEqual(two.room.sources.map((s) => s.label), ['720p', '1080p'], 'both labelled from their names')
assert.equal(two.room.phase, 'idle', 'adding a version does not restart the film')
console.log('· quality options added and labelled')

// a guest can't add or remove versions
qb.send({ type: 'addQuality', url: 'https://cdn.example.com/movie-480p.mp4' })
await new Promise((r) => setTimeout(r, 600))
assert.equal(qb.last('state').room.sources.length, 2, 'guests cannot add versions')

qa.send({ type: 'removeQuality', id: two.room.sources[1].id })
const one = await qa.wait((m) => m.type === 'state' && m.room.sources.length === 1, 8000, true)
assert.equal(one.room.sources[0].label, '720p', 'the right one was removed')
qa.send({ type: 'removeQuality', id: one.room.sources[0].id })
const lastOne = await qa.wait((m) => m.type === 'error', 8000, true)
assert.match(lastOne.error, /only version/i, 'the last version cannot be removed')
console.log('· quality options are host-only and never emptied')

// 24. co-hosts share the controls but not the crown
qa.send({ type: 'cohost', id: qbj.you, on: true })
const promotedCo = await qb.wait(
  (m) => m.type === 'state' && m.room.members.find((x) => x.id === qbj.you)?.coHost, 8000, true)
assert.equal(promotedCo.room.ownerId, qaj.you, 'a co-host is not the owner')

qb.send({ type: 'source', url: 'https://youtu.be/dQw4w9WgXcQ' })
const coLoaded = await qb.wait((m) => m.type === 'state' && m.room.sources[0]?.kind === 'youtube', 10000, true)
assert.ok(coLoaded, 'co-host can load a video')
qb.send({ type: 'start' })
await qb.wait((m) => m.type === 'state' && m.room.phase === 'ready', 8000, true)
console.log('· co-host can load and start')

// but cannot appoint further co-hosts, or take the crown
qb.send({ type: 'cohost', id: qbj.you, on: true })
qb.send({ type: 'promote', id: qbj.you })
await new Promise((r) => setTimeout(r, 700))
assert.equal(qb.last('state').room.ownerId, qaj.you, 'a co-host cannot crown themselves')
console.log('· co-host cannot seize the party')

// and the owner can take it back
qa.send({ type: 'cohost', id: qbj.you, on: false })
const demoted = await qa.wait(
  (m) => m.type === 'state' && !m.room.members.find((x) => x.id === qbj.you)?.coHost, 8000, true)
assert.ok(demoted, 'owner can demote a co-host')
qb.send({ type: 'skip', id: qaj.you })
await new Promise((r) => setTimeout(r, 500))
console.log('· owner can take co-host back')

// 25. the API the Android app depends on
const base = `http://localhost:${PORT}`
const health = await fetch(`${base}/api/v1/health`)
assert.equal(health.status, 200)
assert.equal((await health.json()).ok, true, 'health responds')
assert.equal(health.headers.get('access-control-allow-origin'), '*', 'CORS open for the app WebView')

const pre = await fetch(`${base}/api/v1/party/${code}`)
assert.equal(pre.status, 200)
const info = await pre.json()
assert.equal(info.code, code)
assert.ok('full' in info && 'cap' in info, 'app can tell whether it can get in')
assert.equal((await fetch(`${base}/api/v1/party/ZZZ`)).status, 404, 'unknown code is a 404')

const res = await (await fetch(`${base}/api/v1/resolve?url=${encodeURIComponent('https://youtu.be/dQw4w9WgXcQ')}`)).json()
assert.equal(res.kind, 'youtube', 'app can validate a link before sending it')
assert.equal((await fetch(`${base}/api/v1/resolve?url=nonsense`)).status, 400, 'rubbish rejected')

const pre2 = await fetch(`${base}/api/v1/avatar`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }),
})
assert.equal(pre2.status, 200, 'app can upload an avatar')
assert.ok((await pre2.json()).url.startsWith('/avatars/'))

const opt = await fetch(`${base}/api/v1/health`, { method: 'OPTIONS' })
assert.equal(opt.status, 204, 'preflight answered')
console.log('· app API: health, party, resolve, avatar, CORS')

/* ------------------------------------------------------------------------ *
 * Regressions. Every one of these shipped broken; none of them should return. *
 * ------------------------------------------------------------------------ */

// A two-person party sitting at the ready check, on a YouTube source so there's
// no host to probe and nothing to download.
async function readyParty(tag, cap = 4) {
  const a = client(tag + '-host')
  await a.ready
  a.send({ type: 'create', name: 'H', cap })
  const aj = await a.wait((m) => m.type === 'joined')
  const c = aj.room.code

  const b = client(tag + '-guest')
  await b.ready
  b.send({ type: 'join', code: c, name: 'G' })
  const bj = await b.wait((m) => m.type === 'joined')
  const req = await a.wait((m) => m.type === 'joinreq')
  a.send({ type: 'approve', id: req.id, ok: true })

  a.send({ type: 'source', url: 'https://youtu.be/dQw4w9WgXcQ' })
  await a.wait((m) => m.type === 'state' && m.room.sources.length, 10000)
  a.send({ type: 'start' })
  await b.wait((m) => m.type === 'state' && m.room.phase === 'ready', 8000)
  return { a, b, aj, bj, code: c }
}

// 26. The countdown waits for buffers — and, crucially, comes back. It used to
// flip the room to 'ready' and return without rescheduling itself, so a party
// whose guest was still buffering hung on "Starting…" with nothing left alive
// to restart it.
{
  const { a, b, aj, bj } = await readyParty('gate')
  a.send({ type: 'tick', t: 0, buf: 30 })
  b.send({ type: 'tick', t: 0, buf: 0 }) // nothing downloaded yet
  b.send({ type: 'ready' })
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(a.last('state').room.phase, 'ready', 'countdown holds while someone has no buffer')
  assert.ok(a.last('state').room.waiting.includes(bj.you), 'and says who it is waiting for')

  b.send({ type: 'tick', t: 0, buf: 30 }) // buffer arrives
  const go = await b.wait((m) => m.type === 'state' && m.room.phase === 'playing', 12000, true)
  assert.equal(go.room.paused, false, 'and starts by itself once everyone is loaded')
  a.ws.close(); b.ws.close()
  void aj
  console.log('· countdown waits for buffers, then recovers on its own')
}

// 27. Stopping and starting at the same buffer level makes the room oscillate:
// it resumes the moment the buffer touches the line, drains it, stops again a
// second later. That flapping — several times a minute, on a fine connection —
// was the bug people actually felt.
{
  const { a, b, bj } = await readyParty('hyst')
  a.send({ type: 'tick', t: 0, buf: 30 })
  b.send({ type: 'tick', t: 0, buf: 30 })
  b.send({ type: 'ready' })
  await b.wait((m) => m.type === 'state' && m.room.phase === 'playing', 12000)

  const keep = setInterval(() => a.send({ type: 'tick', t: a.last('state')?.room.t ?? 0, buf: 30 }), 400)
  const starve = setInterval(() => b.send({ type: 'tick', t: a.last('state')?.room.t ?? 0, buf: 0 }), 400)
  const stopped = await a.wait((m) => m.type === 'state' && m.room.paused, 10000, true)
  assert.equal(stopped.room.pausedBy, null, 'the room stopped for a starving viewer')
  clearInterval(starve)

  // Just past the "still playing" threshold, but nowhere near enough to restart on.
  const scrape = setInterval(() => b.send({ type: 'tick', t: a.last('state')?.room.t ?? 0, buf: 1.5 }), 400)
  await new Promise((r) => setTimeout(r, 3000))
  assert.equal(a.last('state').room.paused, true, 'a sliver of buffer does not restart the room')
  clearInterval(scrape)

  const full2 = setInterval(() => b.send({ type: 'tick', t: a.last('state')?.room.t ?? 0, buf: 30 }), 400)
  await a.wait((m) => m.type === 'state' && !m.room.paused, 10000, true)
  clearInterval(full2); clearInterval(keep)
  a.ws.close(); b.ws.close()
  void bj
  console.log('· room stops for a starving viewer and waits for a real cushion')
}

// 28. The owner's player *is* the room clock, but only forwards. A reload or a
// quality switch reads 0 for a moment, and taking that literally threw everyone
// back to the start of the film.
{
  const { a, b } = await readyParty('clock')
  a.send({ type: 'tick', t: 0, buf: 30 })
  b.send({ type: 'tick', t: 0, buf: 30 })
  b.send({ type: 'ready' })
  await b.wait((m) => m.type === 'state' && m.room.phase === 'playing', 12000)
  a.send({ type: 'tick', t: 120, buf: 30 })
  await new Promise((r) => setTimeout(r, 1200))
  assert.ok(a.last('state').room.t >= 120, 'owner drives the clock forward')

  a.send({ type: 'tick', t: 0, buf: 0 }) // a player that has just been reloaded
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok(a.last('state').room.t >= 120, 'a player reading zero does not rewind the room')
  a.ws.close(); b.ws.close()
  console.log('· a reloading owner cannot throw the room back to the start')
}

// 29. Rooms reporting "full" with nobody in them: every member who had ever
// joined counted against the cap forever, and a restored room came back stuffed
// with people who were never returning.
{
  const solo2 = client('seat-host')
  await solo2.ready
  solo2.send({ type: 'create', name: 'H', cap: 2 })
  const sj = await solo2.wait((m) => m.type === 'joined')
  const c2 = sj.room.code

  const tmp = client('seat-guest')
  await tmp.ready
  tmp.send({ type: 'join', code: c2, name: 'Temp' })
  const tr = await solo2.wait((m) => m.type === 'joinreq')
  solo2.send({ type: 'approve', id: tr.id, ok: true })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal((await (await fetch(`${base}/api/v1/party/${c2}`)).json()).full, true, 'two of two seats taken')

  tmp.ws.close() // and they never come back
  await new Promise((r) => setTimeout(r, 2600)) // past SEAT_HOLD_MS
  assert.equal((await (await fetch(`${base}/api/v1/party/${c2}`)).json()).full, false, 'their seat is released')

  const late = client('seat-late')
  await late.ready
  late.send({ type: 'join', code: c2, name: 'Late' })
  const ok = await Promise.race([
    solo2.wait((m) => m.type === 'joinreq' && m.name === 'Late', 4000).then(() => true, () => false),
    late.wait((m) => m.type === 'error', 4000).then(() => false, () => true),
  ])
  assert.equal(ok, true, 'and somebody else can actually take it')
  solo2.ws.close(); late.ws.close()
  console.log('· a seat is released when its occupant does not come back')
}

// 30. Soundboard: one tap, everyone hears it — with a cooldown, because a
// soundboard without one is a weapon.
{
  const { a, b, bj } = await readyParty('sfx')
  b.send({ type: 'sfx', id: 'razzy' })
  const heard = await a.wait((m) => m.type === 'sfx', 5000, true)
  assert.equal(heard.id, 'razzy')
  assert.equal(heard.from, bj.you, 'the room knows who pressed it')

  b.send({ type: 'sfx', id: 'razzy' }) // straight away
  // wait() rejects on timeout, and here the timeout *is* the pass condition
  const spam = await a.wait((m) => m.type === 'sfx', 1000, true).then(() => true, () => false)
  assert.equal(spam, false, 'a second press inside the cooldown is dropped')
  a.ws.close(); b.ws.close()
  console.log('· soundboard reaches the room, and is rate limited')
}

// 31. Walking into a film already well under way. The newcomer's player starts
// at zero, which is far enough from the room clock to hold everyone up — so the
// room stops for them, and the only thing that can clear it is that player
// seeking to where the room actually is. A guard that suppressed exactly that
// seek (because the room was waiting for them) deadlocked the party outright.
{
  const { a, b } = await readyParty('latecomer', 4)
  a.send({ type: 'tick', t: 0, buf: 30 })
  b.send({ type: 'tick', t: 0, buf: 30 })
  b.send({ type: 'ready' })
  await b.wait((m) => m.type === 'state' && m.room.phase === 'playing', 12000)

  // Jump the room well into the film — a newcomer only counts as lost once they
  // are further out than normal drift, so a few seconds in proves nothing.
  a.send({ type: 'seek', t: 600 })
  await new Promise((r) => setTimeout(r, 2000))
  const drive = setInterval(() => {
    const t = a.last('state')?.room.t ?? 600
    a.send({ type: 'tick', t, buf: 30 })
    b.send({ type: 'tick', t, buf: 30 })
  }, 500)
  await new Promise((r) => setTimeout(r, 1500))

  const roomT = a.last('state').room.t
  assert.ok(roomT > 590, `the film is genuinely under way (t=${roomT})`)

  // A third person arrives, and their player knows nothing but t=0.
  const late = client('latecomer-3')
  await late.ready
  late.send({ type: 'join', code: a.last('state').room.code, name: 'Late' })
  const lj = await late.wait((m) => m.type === 'joined')
  const lreq = await a.wait((m) => m.type === 'joinreq' && m.name === 'Late')
  a.send({ type: 'approve', id: lreq.id, ok: true })
  const stuck = setInterval(() => late.send({ type: 'tick', t: 0, buf: 30 }), 500)
  await new Promise((r) => setTimeout(r, 2000))
  assert.ok(a.last('state').room.waiting.includes(lj.you), 'the room waits for someone in the wrong place')
  clearInterval(stuck)
  clearInterval(drive)

  // Their client seeks to the room, which is the whole point.
  const catchUp = setInterval(() => {
    const t = a.last('state')?.room.t ?? 600
    late.send({ type: 'tick', t, buf: 30 })
    a.send({ type: 'tick', t, buf: 30 })
    b.send({ type: 'tick', t, buf: 30 })
  }, 500)
  await a.wait((m) => m.type === 'state' && !m.room.waiting.length && !m.room.paused, 12000, true)
  clearInterval(catchUp)
  a.ws.close(); b.ws.close(); late.ws.close()
  console.log('· joining mid-film does not wedge the room')
}

/* --------------------------------------------------------------- people *
 * Parties are disposable; friends are not. All of this has to work with no
 * party in sight, which is why `hello` exists.
 * ----------------------------------------------------------------------- */
{
  const sign = async (tag, id, name) => {
    const c = client(tag)
    await c.ready
    c.send({ type: 'hello', id, name })
    const me = await c.wait((m) => m.type === 'me')
    return { c, me: me.user }
  }

  const A = await sign('amir', 'user-a', 'Amir')
  const B = await sign('bea', 'user-b', 'Bea')
  assert.equal(A.me.code.length, 6, 'a friend code is six letters')
  assert.notEqual(A.me.code, B.me.code, 'and unique')
  assert.ok(A.me.key, 'and comes with a key for moving devices')

  // Adding by code
  A.c.send({ type: 'friendAdd', code: B.me.code })
  const req = await B.c.wait((m) => m.type === 'friendreq', 5000, true)
  assert.equal(req.from.name, 'Amir', 'the request names who sent it')
  const bPending = await B.c.wait((m) => m.type === 'friends' && m.friends.some((f) => f.incoming), 5000, true)
  assert.equal(bPending.friends[0].id, 'user-a')

  B.c.send({ type: 'friendAccept', id: 'user-a' })
  const aList = await A.c.wait((m) => m.type === 'friends' && m.friends[0]?.accepted, 5000, true)
  assert.equal(aList.friends[0].online, true, 'and they can see each other online')
  console.log('· friends: add by code, accept, presence')

  // Private chat, and it survives being asked for again
  A.c.send({ type: 'dm', id: 'user-b', text: 'you around?' })
  const gotDm = await B.c.wait((m) => m.type === 'dm', 5000, true)
  assert.equal(gotDm.msg.text, 'you around?')
  assert.equal(gotDm.with, 'user-a', 'filed under the person, not the message')
  B.c.send({ type: 'dmHistory', id: 'user-a' })
  const hist = await B.c.wait((m) => m.type === 'dms', 5000, true)
  assert.equal(hist.msgs.at(-1).text, 'you around?', 'history is kept')

  // Strangers can't message
  const { c: stranger } = await sign('cass', 'user-c', 'Cass')
  stranger.send({ type: 'dm', id: 'user-a', text: 'hello?' })
  const refused = await stranger.wait((m) => m.type === 'error', 4000)
  assert.match(refused.error, /friends/i, 'you can only message friends')
  console.log('· friends: private chat, history, and strangers refused')

  // A call needs somewhere to land
  A.c.send({ type: 'call', id: 'user-b' })
  const noParty = await A.c.wait((m) => m.type === 'error', 4000, true)
  assert.match(noParty.error, /party/i, 'calling without a party says so')

  A.c.send({ type: 'create', id: 'user-a', name: 'Amir', cap: 4 })
  const aRoom = await A.c.wait((m) => m.type === 'joined', 5000, true)
  const inParty = await B.c.wait(
    (m) => m.type === 'friends' && m.friends[0]?.party === aRoom.room.code, 6000, true)
  assert.ok(inParty, 'friends can see which party you are in')

  // …and answering walks you into it. No audio anywhere in this.
  A.c.send({ type: 'call', id: 'user-b' })
  const ringing = await B.c.wait((m) => m.type === 'ring', 5000, true)
  assert.equal(ringing.code, aRoom.room.code, 'the ring carries the party')
  B.c.send({ type: 'callAnswer', callId: ringing.callId })
  const landed = await B.c.wait((m) => m.type === 'calljoin', 5000, true)
  assert.equal(landed.code, aRoom.room.code)
  // Not `fresh`: the caller is told before the answerer is, so it has already
  // landed by the time we start listening.
  await A.c.wait((m) => m.type === 'callend' && m.reason === 'answered', 5000)

  // `calljoin` is an instruction to the client; this is what the real one does.
  B.c.send({ type: 'join', code: landed.code, id: 'user-b', name: 'Bea' })
  const seated = await B.c.wait((m) => m.type === 'joined', 6000, true)
  assert.equal(seated.room.code, aRoom.room.code)
  const bea = await B.c.wait(
    (m) => m.type === 'state' && m.room.members.find((x) => x.id === 'user-b')?.approved, 6000, true)
  assert.ok(bea, 'and they walk straight in — the host rang them, they are not queueing')
  console.log('· friends: call rings, answering joins the party')

  // Declining ends it for both
  A.c.send({ type: 'call', id: 'user-c' })
  const notFriend = await A.c.wait((m) => m.type === 'error', 4000, true)
  assert.match(notFriend.error, /friends/i, 'you can only call friends')

  // Invites are the quiet version
  A.c.send({ type: 'invite', id: 'user-b' })
  const inv = await B.c.wait((m) => m.type === 'invite', 5000, true)
  assert.equal(inv.code, aRoom.room.code)

  // Moving to a new device
  const fresh = client('newphone')
  await fresh.ready
  fresh.send({ type: 'restore', code: A.me.code, key: A.me.key })
  const back = await fresh.wait((m) => m.type === 'restored', 5000, true)
  assert.equal(back.user.id, 'user-a', 'the code and key hand back the same identity')
  fresh.send({ type: 'restore', code: A.me.code, key: 'WRONGKEY00' })
  const denied = await fresh.wait((m) => m.type === 'error', 4000, true)
  assert.match(denied.error, /do not match/i, 'and a wrong key does not')
  console.log('· friends: invites, and an identity that moves between devices')

  A.c.ws.close(); B.c.ws.close(); stranger.ws.close(); fresh.ws.close()
}

// 32. Nothing under /api may answer with the SPA's index.html — the app parses
// JSON, and "Unexpected token '<'" is a terrible way to learn a URL is wrong.
{
  const missing = await fetch(`${base}/api/v1/nope`)
  assert.equal(missing.status, 404, 'unknown API route is a 404')
  assert.match(missing.headers.get('content-type') || '', /json/, 'and it is JSON, not a web page')
  console.log('· unknown API routes 404 as JSON')
}

console.log('\nok — end to end passed')
done(0)
