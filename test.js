import assert from 'node:assert/strict'
import { newCode, parsePixeldrain, resolveSource, laggards, syncAction, nextOwner, ALPHABET } from './lib.js'

// codes
const c = newCode()
assert.equal(c.length, 3)
assert.ok([...c].every((ch) => ALPHABET.includes(ch)), 'code uses safe alphabet')
assert.ok(!/[IO01]/.test(c), 'no lookalike characters')
const taken = new Set()
for (let i = 0; i < 200; i++) {
  const x = newCode(taken)
  assert.ok(!taken.has(x), 'never reissues a live code')
  taken.add(x)
}

// pixeldrain parsing
assert.equal(parsePixeldrain('https://pixeldrain.com/u/GKBvQx7Y'), 'GKBvQx7Y')
assert.equal(parsePixeldrain('https://pixeldrain.com/api/file/GKBvQx7Y'), 'GKBvQx7Y')
assert.equal(parsePixeldrain('  https://pixeldrain.com/u/GKBvQx7Y  '), 'GKBvQx7Y')
assert.equal(parsePixeldrain('https://example.com/movie.mp4'), null)
assert.equal(parsePixeldrain(''), null)
assert.equal(resolveSource('https://pixeldrain.com/u/GKBvQx7Y').url, 'https://pixeldrain.com/api/file/GKBvQx7Y')
assert.equal(resolveSource('https://cdn.example.com/a.mp4').url, 'https://cdn.example.com/a.mp4')
assert.equal(resolveSource('http://insecure.example.com/a.mp4'), null, 'https only')
assert.equal(resolveSource('https://youtube.com/watch?v=x'), null, 'no DRM/player sites')

// laggards: who holds the room up
const M = (o) => ({ online: true, approved: true, buffering: false, t: 100, skipped: false, ...o })
assert.equal(laggards([M({ id: 'a' }), M({ id: 'b', t: 99 })], 100).length, 0, '1s behind is fine')
assert.equal(laggards([M({ id: 'b', t: 90 })], 100)[0].id, 'b', '10s behind holds the room')
assert.equal(laggards([M({ id: 'b', buffering: true })], 100)[0].id, 'b', 'buffering holds the room')
assert.equal(laggards([M({ id: 'b', t: 90, skipped: true })], 100).length, 0, 'owner skipped them')
assert.equal(laggards([M({ id: 'b', t: 90, online: false })], 100).length, 0, 'offline never blocks')
assert.equal(laggards([M({ id: 'b', t: 90, approved: false })], 100).length, 0, 'pending never blocks')
assert.equal(laggards([M({ id: 'b', t: 400 })], 100).length, 0, 'ahead is not behind')

// drift correction
assert.equal(syncAction(100, 100).rate, 1)
assert.equal(syncAction(100, 100).seek, null)
assert.equal(syncAction(100, 100.5).seek, null, 'small drift nudges rate, never seeks')
assert.ok(syncAction(100, 100.5).rate > 1, 'behind -> speed up')
assert.ok(syncAction(100, 99.5).rate < 1, 'ahead -> slow down')
assert.equal(syncAction(100, 105).seek, 105, 'big drift seeks')
assert.equal(syncAction(100, 105).rate, 1, 'seeking resets rate')

// crown transfer
const mem = [
  { id: 'owner', online: true, approved: true, joinedAt: 1 },
  { id: 'late', online: true, approved: true, joinedAt: 30 },
  { id: 'early', online: true, approved: true, joinedAt: 10 },
  { id: 'gone', online: false, approved: true, joinedAt: 2 },
]
assert.equal(nextOwner(mem, 'owner'), 'early', 'longest-present online member')
assert.equal(nextOwner([mem[0]], 'owner'), null, 'nobody left')

console.log('ok — all checks passed')
