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

// https://pixeldrain.com/u/GKBvQx7Y -> GKBvQx7Y ; also accepts a bare id or a direct file url
export function parsePixeldrain(url) {
  const s = String(url || '').trim()
  const m = s.match(/pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9]+)/)
  if (m) return m[1]
  if (/^[A-Za-z0-9]{6,12}$/.test(s)) return s
  return null
}

export function pixeldrainFile(id) {
  return `https://pixeldrain.com/api/file/${id}`
}

// Direct media links are allowed through untouched.
export function resolveSource(url) {
  const id = parsePixeldrain(url)
  if (id) return { url: pixeldrainFile(id), id }
  if (/^https:\/\/\S+\.(mp4|webm|m4v|mov)(\?\S*)?$/i.test(url)) return { url: url.trim(), id: null }
  return null
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
