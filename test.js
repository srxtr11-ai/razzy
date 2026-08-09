import assert from 'node:assert/strict'
import { BUF, newCode, parsePixeldrain, parseYouTube, qualityLabel, resolveSource, holdingUp, syncAction, nextOwner, ALPHABET } from './lib.js'

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
assert.equal(parsePixeldrain('nonsense'), null, 'a bare word is not a file id')
assert.equal(parsePixeldrain('GKBvQx7Y'), null, 'the domain is required, not just the shape')
assert.equal(resolveSource('https://pixeldrain.com/u/GKBvQx7Y').source, 'https://pixeldrain.com/api/file/GKBvQx7Y')
assert.equal(resolveSource('https://pixeldrain.com/u/GKBvQx7Y').kind, 'file')
assert.equal(resolveSource('https://cdn.example.com/a.mp4').source, 'https://cdn.example.com/a.mp4')
assert.equal(resolveSource('http://insecure.example.com/a.mp4'), null, 'https only')

// youtube — every URL shape carries the same 11-char id
assert.equal(parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
assert.equal(parseYouTube('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
assert.equal(parseYouTube('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
assert.equal(parseYouTube('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
assert.equal(parseYouTube('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
assert.equal(parseYouTube('https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'id after other params')
assert.equal(parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ', 'trailing params ignored')
assert.equal(parseYouTube('https://pixeldrain.com/u/GKBvQx7Y'), null)
assert.equal(parseYouTube('https://example.com/watch?v=short'), null, 'needs a real 11-char id')

const yt = resolveSource('https://youtu.be/dQw4w9WgXcQ')
assert.equal(yt.kind, 'youtube')
assert.equal(yt.source, 'dQw4w9WgXcQ', 'youtube carries the id, not a byte URL')
assert.equal(resolveSource('https://example.com/page.html'), null, 'arbitrary pages still refused')

// quality labels come from the file name, since nobody wants to type them
assert.equal(qualityLabel('11eyes 003 720p.mp4'), '720p')
assert.equal(qualityLabel('Movie.2019.1080p.BluRay.mkv'), '1080p')
assert.equal(qualityLabel('https://cdn.example.com/clip-480p.mp4'), '480p')
assert.equal(qualityLabel('Show.S01E02.2160p.mp4'), '2160p')
assert.equal(qualityLabel('something 4K remux.mp4'), '2160p')
assert.equal(qualityLabel('holiday.mp4'), 'Source', 'no hint -> fallback')
assert.equal(qualityLabel('holiday.mp4', 'Option 2'), 'Option 2', 'caller picks the fallback')
assert.equal(qualityLabel('720pixels of nothing.mp4'), 'Source', 'not a bare resolution token')

// holdingUp: who the room is waiting for
const M = (o) => ({ online: true, approved: true, buf: 10, t: 100, skipped: false, ...o })
assert.equal(holdingUp([M({ id: 'a' }), M({ id: 'b', t: 99 })], 100).length, 0, 'a second behind is fine')
assert.equal(holdingUp([M({ id: 'b', buf: 0.1 })], 100)[0].id, 'b', 'out of buffer holds the room')
assert.equal(holdingUp([M({ id: 'b', t: 80 })], 100)[0].id, 'b', 'far enough behind is lost, not slow')
assert.equal(holdingUp([M({ id: 'b', buf: 0.1, skipped: true })], 100).length, 0, 'host skipped them')
assert.equal(holdingUp([M({ id: 'b', buf: 0.1, online: false })], 100).length, 0, 'offline never blocks')
assert.equal(holdingUp([M({ id: 'b', buf: 0.1, approved: false })], 100).length, 0, 'pending never blocks')
assert.equal(holdingUp([M({ id: 'b', t: 400 })], 100).length, 0, 'ahead is not behind')
assert.equal(holdingUp([M({ id: 'b', buf: undefined })], 100).length, 0, 'never reported gets the benefit')

// The thresholds must not be one number, or the room oscillates: it resumes the
// instant the buffer touches the line, drains it, and stops again a second later.
assert.ok(BUF.resume > BUF.low * 3, 'stop and start levels are far apart')
const thin = [M({ id: 'b', buf: 2 })]
assert.equal(holdingUp(thin, 100, BUF.low).length, 0, '2s in hand keeps playing')
assert.equal(holdingUp(thin, 100, BUF.resume)[0].id, 'b', 'but is not enough to restart on')

// drift correction: seeking abandons the buffer, so it is the last resort
assert.equal(syncAction(100, 100).rate, 1)
assert.equal(syncAction(100, 100).seek, null)
assert.equal(syncAction(100, 100.5).seek, null, 'small drift nudges rate, never seeks')
assert.ok(syncAction(100, 100.5).rate > 1, 'behind -> speed up')
assert.ok(syncAction(100, 99.5).rate < 1, 'ahead -> slow down')
assert.equal(syncAction(100, 105).seek, null, 'five seconds behind still rides the rate')
assert.ok(syncAction(100, 105).rate <= 1.1, 'and never at a silly speed')
assert.equal(syncAction(100, 130).seek, 130, 'genuinely lost -> seek')
assert.equal(syncAction(100, 130).rate, 1, 'seeking resets rate')

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
