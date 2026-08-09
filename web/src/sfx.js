/**
 * Soundboard.
 *
 * A tap plays the clip for *everyone* in the party — that's the whole point, so
 * the server just relays the id and each client plays its own local copy. No
 * audio crosses the wire and nothing has to stay in sync.
 *
 * To add one: drop the file in `public/sfx/` and add a line here. Keep them
 * short; this is a reaction button, not a second soundtrack.
 */
export const SOUNDS = [{ id: 'razzy', label: 'Razzy', src: '/sfx/razzy.mp3' }]

// Warmed once so the first press isn't a wait for the network.
const warm = new Map()
for (const s of SOUNDS) {
  if (typeof Audio === 'undefined') break
  const a = new Audio(s.src)
  a.preload = 'auto'
  warm.set(s.id, a)
}

/** Currently sounding, so a burst can be capped rather than left to pile up. */
const live = []

export function playSound(id) {
  const sound = SOUNDS.find((s) => s.id === id)
  if (!sound) return

  /*
   * A fresh element per press.
   *
   * One shared element rewound on every press meant two people tapping within a
   * few seconds chopped each other off — each press cut the last one dead a
   * fraction of a second in, which is a stutter of blips rather than a clip.
   */
  const audio = new Audio(sound.src)
  audio.volume = 0.85
  audio.addEventListener('ended', () => {
    const i = live.indexOf(audio)
    if (i >= 0) live.splice(i, 1)
  })
  live.push(audio)
  // Three at once is a room laughing; ten is a fire alarm.
  while (live.length > 3) live.shift()?.pause()
  audio.play().catch(() => {}) // autoplay policy before any tap; nothing to do
}
