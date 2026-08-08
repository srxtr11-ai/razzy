import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

/**
 * Two very different playback engines behind one small interface, so the sync
 * logic in Room.jsx never has to care which is on screen:
 *
 *   play() -> Promise   resolves once actually playing, rejects if blocked
 *   pause()
 *   seek(t)
 *   time()              seconds
 *   duration()          seconds, 0 until known
 *   ready()             0..4, mirroring HTMLMediaElement.readyState
 *   isPaused()
 *   reload()            last resort for a wedged player
 *
 * A file is bytes we control. YouTube is an iframe we can only ask politely —
 * its bytes never touch our server, which is the whole reason it's supported
 * this way rather than by ripping stream URLs.
 */

export const FilePlayer = forwardRef(function FilePlayer({ src, onDuration }, ref) {
  const el = useRef(null)

  useImperativeHandle(ref, () => ({
    play: () => el.current?.play() ?? Promise.reject(),
    // Muted playback is always allowed. Falling back to it keeps someone in
    // sync with the room instead of stalling everyone on their autoplay policy.
    playMuted: () => {
      if (!el.current) return Promise.reject()
      el.current.muted = true
      return el.current.play()
    },
    unmute: () => { if (el.current) el.current.muted = false },
    pause: () => el.current?.pause(),
    seek: (t) => { if (el.current) el.current.currentTime = t },
    time: () => el.current?.currentTime ?? 0,
    duration: () => (isFinite(el.current?.duration) ? el.current.duration : 0),
    ready: () => el.current?.readyState ?? 0,
    isPaused: () => el.current?.paused ?? true,
    rate: (r) => { if (el.current) el.current.playbackRate = r },
    reload: () => el.current?.load(),
  }), [])

  return (
    <video
      ref={el}
      src={src}
      className="absolute inset-0 w-full h-full object-contain bg-black"
      playsInline
      preload="auto"
      onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration)}
    />
  )
})

/* ------------------------------------------------------------------ youtube */

let apiPromise
function loadApi() {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT)
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT) }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(s)
  })
  return apiPromise
}

const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }

export const YouTubePlayer = forwardRef(function YouTubePlayer({ videoId, onDuration }, ref) {
  const host = useRef(null)
  const yt = useRef(null)
  const state = useRef(YT_STATE.UNSTARTED)
  const bufferingSince = useRef(0)

  useEffect(() => {
    let dead = false
    let player
    loadApi().then((YT) => {
      if (dead || !host.current) return
      player = new YT.Player(host.current, {
        videoId,
        playerVars: {
          controls: 0, disablekb: 1, modestbranding: 1, rel: 0,
          playsinline: 1, iv_load_policy: 3, fs: 0,
        },
        events: {
          onReady: (e) => { yt.current = e.target; onDuration?.(e.target.getDuration()) },
          onStateChange: (e) => {
            state.current = e.data
            if (e.data === YT_STATE.BUFFERING) bufferingSince.current ||= Date.now()
            else bufferingSince.current = 0
            if (e.data === YT_STATE.PLAYING) onDuration?.(e.target.getDuration())
          },
        },
      })
    })
    return () => { dead = true; try { player?.destroy() } catch {} yt.current = null }
  }, [videoId]) // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    // No promise from playVideo(), so watch the state instead: if it hasn't
    // reached PLAYING shortly after asking, autoplay was refused.
    play: () =>
      new Promise((resolve, reject) => {
        const p = yt.current
        if (!p) return reject()
        p.playVideo()
        const started = Date.now()
        const check = setInterval(() => {
          if (state.current === YT_STATE.PLAYING || state.current === YT_STATE.BUFFERING) {
            clearInterval(check); resolve()
          } else if (Date.now() - started > 2000) {
            clearInterval(check); reject()
          }
        }, 120)
      }),
    playMuted: () =>
      new Promise((resolve, reject) => {
        const p = yt.current
        if (!p) return reject()
        p.mute()
        p.playVideo()
        const started = Date.now()
        const check = setInterval(() => {
          if (state.current === YT_STATE.PLAYING || state.current === YT_STATE.BUFFERING) {
            clearInterval(check); resolve()
          } else if (Date.now() - started > 2500) {
            clearInterval(check); reject()
          }
        }, 120)
      }),
    unmute: () => { try { yt.current?.unMute() } catch {} },
    pause: () => yt.current?.pauseVideo(),
    seek: (t) => yt.current?.seekTo(t, true),
    time: () => yt.current?.getCurrentTime?.() ?? 0,
    duration: () => yt.current?.getDuration?.() ?? 0,
    // Map YouTube's states onto readyState so the room's buffering rules,
    // straggler detection and countdown all keep working unchanged.
    ready: () => {
      if (!yt.current) return 0
      if (state.current === YT_STATE.UNSTARTED) return 1
      // YouTube flicks through BUFFERING every time you resume or seek. Reporting
      // that instantly made the room stop for everyone on every un-pause, so only
      // a buffer that actually persists counts as starving.
      if (state.current === YT_STATE.BUFFERING) return Date.now() - bufferingSince.current > 1500 ? 1 : 4
      return 4
    },
    isPaused: () => state.current !== YT_STATE.PLAYING && state.current !== YT_STATE.BUFFERING,
    rate: (r) => { try { yt.current?.setPlaybackRate(r) } catch {} },
    reload: () => { const p = yt.current; if (p) { p.seekTo(p.getCurrentTime(), true); p.playVideo() } },
  }), [])

  return (
    <div className="absolute inset-0 bg-black">
      {/* the API replaces this node with the iframe */}
      <div ref={host} className="w-full h-full pointer-events-none" />
    </div>
  )
})
