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

const cache = new Map()

export function playSound(id) {
  const sound = SOUNDS.find((s) => s.id === id)
  if (!sound) return
  let audio = cache.get(id)
  if (!audio) {
    audio = new Audio(sound.src)
    audio.preload = 'auto'
    cache.set(id, audio)
  }
  // Restart rather than overlap — two people tapping at once should be one
  // sound, not a mess.
  audio.currentTime = 0
  audio.volume = 0.85
  audio.play().catch(() => {}) // autoplay policy before any tap; nothing to do
}
