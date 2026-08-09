import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

/**
 * Two very different playback engines behind one small interface, so the sync
 * logic in Room.jsx never has to care which is on screen:
 *
 *   play() -> Promise   resolves once actually playing, rejects if blocked
 *   pause()
 *   seek(t)
 *   time()              seconds
 *   duration()          seconds, 0 until known
 *   buffered()          seconds downloaded *ahead of the playhead*
 *   loading()           is data still arriving? (a slow player, not a dead one)
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
    /**
     * How many seconds are already downloaded in front of us. This is the
     * number the whole sync system runs on: readyState says "I have a frame",
     * which is true right up to the instant the video stalls again.
     */
    buffered: () => {
      const v = el.current
      if (!v) return 0
      const t = v.currentTime
      for (let i = 0; i < v.buffered.length; i++) {
        // 0.25s of slack: the range boundary rarely lands exactly on the playhead
        if (v.buffered.start(i) <= t + 0.25 && v.buffered.end(i) > t) return v.buffered.end(i) - t
      }
      return 0
    },
    // NETWORK_LOADING. Tells "slow" apart from "wedged", which look identical
    // from the outside and want opposite treatment.
    loading: () => el.current?.networkState === 2,
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

// "However much the room needs" — YouTube's buffer isn't measurable, see below.
const PLENTY = 999

/** YouTube's internal level names, in the terms people actually use. */
export const YT_LABEL = {
  highres: '4320p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p',
  large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto',
}

export const YouTubePlayer = forwardRef(function YouTubePlayer({ videoId, onDuration }, ref) {
  const host = useRef(null)
  const yt = useRef(null)
  const state = useRef(YT_STATE.UNSTARTED)
  const bufferingSince = useRef(0)
  const resumeAt = useRef(0)
  /**
   * Whether to hand the viewer YouTube's own control bar.
   *
   * This is the only way a viewer can change YouTube's quality. Everything the
   * page can ask for is ignored: setPlaybackQuality() has been a no-op for
   * years, and the undocumented `vq` player var and setPlaybackQualityRange()
   * were both measured doing nothing here — the embed kept serving 480p when
   * asked for 1080p *and* when asked for 144p, at a 1016x756 player. YouTube's
   * own settings menu is the one place the choice sticks, so that is what gets
   * offered rather than a row of buttons that quietly do nothing.
   *
   * Changing it rebuilds the player, so it lives in state.
   */
  const [ownControls, setOwnControls] = useState(false)

  useEffect(() => {
    let dead = false
    let player
    // YT.Player *replaces* the element it is handed with the iframe, so the node
    // is gone the moment the player exists. Building a second player on the same
    // ref therefore targets a detached div: it never becomes ready, buffered()
    // reports nothing forever, and the room stops for a viewer whose player will
    // never come back. Hence a fresh throwaway child on every build.
    const mount = document.createElement('div')
    mount.style.width = '100%'
    mount.style.height = '100%'
    host.current?.appendChild(mount)

    loadApi().then((YT) => {
      if (dead || !host.current) return
      player = new YT.Player(mount, {
        videoId,
        playerVars: {
          controls: ownControls ? 1 : 0, disablekb: 1, modestbranding: 1, rel: 0,
          playsinline: 1, iv_load_policy: 3, fs: 0,
          ...(resumeAt.current > 1 ? { start: Math.floor(resumeAt.current) } : {}),
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
    return () => {
      dead = true
      try { player?.destroy() } catch {}
      yt.current = null
      state.current = YT_STATE.UNSTARTED // or the next player inherits a stale one
      if (host.current) host.current.innerHTML = '' // whatever destroy() left
    }
  }, [videoId, ownControls]) // eslint-disable-line react-hooks/exhaustive-deps

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
    /**
     * There's no buffered TimeRanges here, only "how much of the video is
     * loaded" as a fraction, so the seconds in hand have to be derived. Sitting
     * in BUFFERING for real overrides it: at that point the number is a
     * leftover from before the stall, whatever it says.
     */
    /**
     * YouTube downloads only while it is playing, and only ever reports a coarse
     * "fraction loaded". Asking it for seconds-in-hand while it is paused or not
     * yet started is a deadlock by construction: it cannot fill, so a room that
     * waits for the number to rise waits forever. That bit twice — once holding
     * the countdown for a player that only buffers *after* the countdown, and
     * once leaving a room stopped for a viewer whose player was paused
     * precisely because the room had stopped.
     *
     * So the only state here that honestly means "out of video" is a stall that
     * persists. YouTube does its own buffering the rest of the time, and a
     * player that is genuinely broken still gets caught by the clock-drift
     * backstop in holdingUp().
     */
    buffered: () => {
      if (state.current !== YT_STATE.BUFFERING) return PLENTY
      return Date.now() - bufferingSince.current > 1500 ? 0 : PLENTY
    },
    loading: () => state.current === YT_STATE.BUFFERING,
    isPaused: () => state.current !== YT_STATE.PLAYING && state.current !== YT_STATE.BUFFERING,
    rate: (r) => { try { yt.current?.setPlaybackRate(r) } catch {} },
    /** What is genuinely on screen — YouTube has the final say, so ask it. */
    quality: () => {
      try { return yt.current?.getPlaybackQuality?.() || 'auto' } catch { return 'auto' }
    },
    ownControls: () => ownControls,
    /** Hand the viewer YouTube's own gear menu, resuming where they were. */
    setOwnControls: (on) => {
      try { resumeAt.current = yt.current?.getCurrentTime?.() || 0 } catch {}
      setOwnControls(!!on)
    },
    reload: () => { const p = yt.current; if (p) { p.seekTo(p.getCurrentTime(), true); p.playVideo() } },
  }), [ownControls])

  return (
    <div className="absolute inset-0 bg-black">
      {/* Container only — React must not own the node the API swallows. Taps go
          through to YouTube only when the viewer has asked for its controls;
          otherwise the film is Razzy's to drive. */}
      <div ref={host} className={`w-full h-full ${ownControls ? '' : 'pointer-events-none'}`} />
    </div>
  )
})

/**
 * Picks the engine for a source, so both clients agree on what plays what and
 * neither has to grow a branch every time a service is added. `media` lets the
 * Android build turn a proxied path into an absolute URL.
 */
export const Player = forwardRef(function Player({ source, media, onDuration }, ref) {
  if (!source) return null
  if (source.kind === 'youtube') return <YouTubePlayer ref={ref} videoId={source.source} onDuration={onDuration} />
  if (source.kind === 'soundcloud') return <SoundCloudPlayer ref={ref} url={source.source} onDuration={onDuration} />
  if (source.kind === 'spotify') return <SpotifyPlayer ref={ref} source={source.source} onDuration={onDuration} />
  return <FilePlayer ref={ref} src={media ? media(source.source) : source.source} onDuration={onDuration} />
})

/* --------------------------------------------------------------- music */

/**
 * SoundCloud and Spotify both hand out an embed that needs no key, no token and
 * no registered application — which is the only reason they're here. Both also
 * answer questions asynchronously, through callbacks and events, while the sync
 * loop needs `time()` to return a number right now. So both keep a small mirror
 * of the player's state, refreshed by events and by a poll, and the getters read
 * the mirror.
 *
 * Neither supports a playback rate, so `canRate()` is false and drift gets
 * corrected by seeking — which is fine here, where a track is a few megabytes
 * rather than a two-hour film.
 */

const scripts = new Map()

/** Load a third-party script once, and wait until it has actually announced itself. */
function loadScript(src, ready) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve) => {
      if (ready()) return resolve(true)
      const s = document.createElement('script')
      s.src = src
      s.onload = () => {
        // onload only means "parsed" — several of these publish their API a tick
        // later, or through a global callback.
        const wait = setInterval(() => { if (ready()) { clearInterval(wait); resolve(true) } }, 50)
        setTimeout(() => { clearInterval(wait); resolve(!!ready()) }, 8000)
      }
      s.onerror = () => resolve(false)
      document.head.appendChild(s)
    }))
  }
  return scripts.get(src)
}

/**
 * Spotify hands its API to a global callback rather than exposing it, so the
 * hook has to be in place before the script is fetched.
 */
function loadSpotify() {
  if (!window.__razzySpotifyHook) {
    window.__razzySpotifyHook = true
    const prev = window.onSpotifyIframeApiReady
    window.onSpotifyIframeApiReady = (api) => { window.__razzySpotify = api; prev?.(api) }
  }
  return loadScript('https://open.spotify.com/embed/iframe-api/v1', () => window.__razzySpotify)
}

export const SoundCloudPlayer = forwardRef(function SoundCloudPlayer({ url, onDuration }, ref) {
  const frame = useRef(null)
  const widget = useRef(null)
  const at = useRef(0)
  const dur = useRef(0)
  const paused = useRef(true)

  useEffect(() => {
    let dead = false
    let poll
    loadScript('https://w.soundcloud.com/player/api.js', () => window.SC?.Widget).then(() => {
      if (dead || !frame.current || !window.SC?.Widget) return
      const w = window.SC.Widget(frame.current)
      widget.current = w
      const E = window.SC.Widget.Events
      w.bind(E.READY, () => {
        w.getDuration((ms) => { dur.current = (ms || 0) / 1000; onDuration?.(dur.current) })
      })
      w.bind(E.PLAY, () => { paused.current = false })
      w.bind(E.PAUSE, () => { paused.current = true })
      w.bind(E.FINISH, () => { paused.current = true })
      w.bind(E.PLAY_PROGRESS, (e) => { at.current = (e?.currentPosition || 0) / 1000 })
      // PLAY_PROGRESS stops while paused, and a seek made while paused would
      // otherwise never be reflected — so ask directly as well.
      poll = setInterval(() => {
        try {
          w.getPosition((ms) => { at.current = (ms || 0) / 1000 })
          w.isPaused((p) => { paused.current = !!p })
        } catch {}
      }, 500)
    })
    return () => { dead = true; clearInterval(poll); widget.current = null }
  }, [url]) // eslint-disable-line react-hooks/exhaustive-deps

  const started = (ms) =>
    new Promise((resolve, reject) => {
      const w = widget.current
      if (!w) return reject()
      w.play()
      const from = Date.now()
      const check = setInterval(() => {
        if (!paused.current) { clearInterval(check); resolve() }
        else if (Date.now() - from > ms) { clearInterval(check); reject() }
      }, 120)
    })

  useImperativeHandle(ref, () => ({
    // A cold widget takes a few seconds to get going; a short window here just
    // means falling back to muted playback for no reason.
    play: () => { try { widget.current?.setVolume(100) } catch {} ; return started(5000) },
    playMuted: () => { try { widget.current?.setVolume(0) } catch {} ; return started(5000) },
    unmute: () => { try { widget.current?.setVolume(100) } catch {} },
    pause: () => { try { widget.current?.pause() } catch {} },
    seek: (t) => { try { widget.current?.seekTo(Math.max(0, t) * 1000); at.current = t } catch {} },
    time: () => at.current,
    duration: () => dur.current,
    ready: () => (widget.current ? 4 : 0),
    buffered: () => PLENTY, // not measurable, and a track is small enough not to matter
    loading: () => true,
    isPaused: () => paused.current,
    /**
     * Never report a position to the room.
     *
     * A SoundCloud widget ignores `seekTo` while it is paused, and won't report
     * anything at all until it has played once. So a widget that starts a few
     * seconds late looks far behind, the room stops to wait for it — and a
     * stopped widget can neither seek nor start. It waits forever.
     *
     * Waiting for a music player is pointless anyway: there is nothing it can do
     * while stopped. So it never holds the room up. The room clock just runs, the
     * track runs alongside it, and any drift is corrected by a seek during
     * playback, which does work.
     */
    hasPosition: () => false,
    canRate: () => false,
    rate: () => {},
    quality: () => 'auto',
    reload: () => { try { widget.current?.seekTo(at.current * 1000); widget.current?.play() } catch {} },
  }), [])

  return (
    <div className="absolute inset-0 bg-black">
      <iframe
        ref={frame}
        title="SoundCloud"
        className="w-full h-full border-0"
        allow="autoplay"
        src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&hide_related=true&show_comments=false&show_teaser=false&visual=true&color=%2322c55e`}
      />
    </div>
  )
})

export const SpotifyPlayer = forwardRef(function SpotifyPlayer({ source, onDuration }, ref) {
  const host = useRef(null)
  const ctrl = useRef(null)
  const at = useRef(0)
  const dur = useRef(0)
  const paused = useRef(true)

  useEffect(() => {
    let dead = false
    const mount = document.createElement('div')
    host.current?.appendChild(mount)

    loadSpotify().then(() => {
      if (dead || !window.__razzySpotify) return
      window.__razzySpotify.createController(
        mount,
        { uri: `spotify:${source.replace('/', ':')}`, width: '100%', height: '100%' },
        (controller) => {
          if (dead) { try { controller.destroy() } catch {} ; return }
          ctrl.current = controller
          controller.addListener('playback_update', (e) => {
            const d = e?.data || {}
            at.current = (d.position || 0) / 1000
            if (d.duration) {
              const secs = d.duration / 1000
              if (secs !== dur.current) { dur.current = secs; onDuration?.(secs) }
            }
            paused.current = !!d.isPaused
          })
        }
      )
    })
    return () => {
      dead = true
      try { ctrl.current?.destroy() } catch {}
      ctrl.current = null
      if (host.current) host.current.innerHTML = ''
    }
  }, [source]) // eslint-disable-line react-hooks/exhaustive-deps

  const started = (ms) =>
    new Promise((resolve, reject) => {
      const c = ctrl.current
      if (!c) return reject()
      try { c.resume() } catch { try { c.play() } catch {} }
      const from = Date.now()
      const check = setInterval(() => {
        if (!paused.current) { clearInterval(check); resolve() }
        else if (Date.now() - from > ms) { clearInterval(check); reject() }
      }, 150)
    })

  useImperativeHandle(ref, () => ({
    play: () => started(2500),
    // No volume control on the embed, so there is no muted fallback to offer —
    // if the browser refuses to start it, only a tap will do.
    playMuted: () => Promise.reject(),
    unmute: () => {},
    pause: () => { try { ctrl.current?.pause() } catch {} },
    seek: (t) => { try { ctrl.current?.seek(Math.max(0, t)); at.current = t } catch {} },
    time: () => at.current,
    duration: () => dur.current,
    ready: () => (ctrl.current ? 4 : 0),
    buffered: () => PLENTY,
    loading: () => true,
    isPaused: () => paused.current,
    hasPosition: () => false, // see the SoundCloud note above — same reasoning
    canRate: () => false,
    rate: () => {},
    quality: () => 'auto',
    reload: () => { try { ctrl.current?.seek(at.current); ctrl.current?.resume() } catch {} },
  }), [])

  return (
    <div className="absolute inset-0 bg-black grid place-items-center">
      <div ref={host} className="w-full h-full max-w-2xl" />
    </div>
  )
})
