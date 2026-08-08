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
  env: { ...process.env, PORT, DATA_DIR: DATA, OWNER_GRACE_MS: 2000 },
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
        const t = setTimeout(() => rej(new Error(`${label}: timeout waiting for message`)), ms)
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
assert.equal(host.last('state').room.source, null, 'guest cannot set the source')

host.send({ type: 'source', url: 'https://www.youtube.com/watch?v=abc' })
await host.wait((m) => m.type === 'error')
host.send({ type: 'source', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
const withSrc = await guest.wait((m) => m.type === 'state' && m.room.source, 15000)
assert.equal(withSrc.room.origin, 'https://pixeldrain.com/api/file/GKBvQx7Y', 'pixeldrain link resolved')
// PixelDrain blocks cross-site playback, so the server must have chosen to stream it
assert.equal(withSrc.room.proxied, true, 'hotlink-blocking host gets proxied')
assert.match(withSrc.room.source, /^\/stream\//, 'client is pointed at our stream route')
console.log('· source resolved, hotlink block detected -> proxying')

// the stream route must actually return video bytes, and refuse anything not a live source
const ranged = await fetch(`http://localhost:${PORT}${withSrc.room.source}`, { headers: { Range: 'bytes=0-999' } })
assert.equal(ranged.status, 206, 'range request passes through')
assert.equal(ranged.headers.get('content-type'), 'video/mp4', 'video content type preserved')
assert.equal((await ranged.arrayBuffer()).byteLength, 1000, 'exactly the requested bytes')
const openProxy = await fetch(`http://localhost:${PORT}/stream/${Buffer.from('https://example.com/evil.mp4').toString('base64url')}`)
assert.equal(openProxy.status, 403, 'not usable as an open proxy')
console.log('· stream route serves ranges and refuses foreign URLs')

// 6. ready check -> countdown -> playing
host.send({ type: 'start' })
await guest.wait((m) => m.type === 'state' && m.room.phase === 'ready')
host.send({ type: 'tick', t: 0, buffering: false })
guest.send({ type: 'tick', t: 0, buffering: false })
guest.send({ type: 'ready' })
const three = await guest.wait((m) => m.type === 'countdown')
assert.equal(three.n, 3, 'countdown starts at 3')
const playing = await guest.wait((m) => m.type === 'state' && m.room.phase === 'playing' && !m.room.paused, 10000)
assert.equal(playing.room.paused, false, 'room is playing')
console.log('· ready check + countdown -> playing')

// 7. the room clock advances
const t0 = playing.room.t
host.send({ type: 'tick', t: t0 + 2, buffering: false })
await new Promise((r) => setTimeout(r, 1500))
assert.ok(host.last('state').room.t > t0, 'clock advanced')

// 8. anyone can pause
guest.send({ type: 'pause' })
const paused = await host.wait((m) => m.type === 'state' && m.room.paused, 8000, true)
assert.equal(paused.room.pausedBy, guestJoined.you, 'the room knows who paused')
console.log('· guest paused the room')

// 9. a straggler holds the room, and the owner can skip them
guest.send({ type: 'tick', t: 0, buffering: true })
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
await solo.wait((m) => m.type === 'state' && m.room.source, 15000)
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
const src = `http://localhost:${PORT}${withSrc.room.source}`
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
const ytState = await ytc.wait((m) => m.type === 'state' && m.room.source, 10000)
assert.equal(ytState.room.kind, 'youtube', 'recognised as a youtube source')
assert.equal(ytState.room.source, 'dQw4w9WgXcQ', 'the client gets the video id, not a byte URL')
assert.equal(ytState.room.proxied, false, 'youtube bytes never touch this server')
assert.ok(!ytState.room.source.startsWith('/stream/'), 'not routed through the proxy')

// and the proxy refuses to fetch it even if someone asks directly
const ytProxy = await fetch(
  `http://localhost:${PORT}/stream/${Buffer.from('https://www.youtube.com/watch?v=dQw4w9WgXcQ').toString('base64url')}`)
assert.equal(ytProxy.status, 403, 'youtube cannot be pulled through the stream route')
console.log('· youtube accepted, embedded not proxied')

// 22. a file source in the same server still proxies — the two paths coexist
ytc.send({ type: 'source', url: 'https://pixeldrain.com/u/GKBvQx7Y' })
const backToFile = await ytc.wait((m) => m.type === 'state' && m.room.kind === 'file', 15000, true)
assert.equal(backToFile.room.proxied, true, 'switching back to a file still proxies')
console.log('· switching between youtube and file sources works')

console.log('\nok — end to end passed')
done(0)
