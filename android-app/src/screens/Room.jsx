import { useEffect, useRef, useState } from 'react'
import { BUF, syncAction } from '../../../lib.js'
import {
  Check, Crown, Gamepad2, Loader2, LogOut, Maximize2, MessageCircle, Minimize2, Pause, Play,
  Send, Settings, Shield, SkipForward, UserX, Volume2, X, Zap,
} from 'lucide-react'
import { api, immersive } from '../api.js'
import { FilePlayer, YouTubePlayer, YT_LABEL } from '../components/players.jsx'
import { SOUNDS, playSound } from '../sfx.js'
import { Avatar, Button, CoHostBadge, OwnerBadge, Signal, fmt, useKeyboardInset, useLayout } from '../components/ui.jsx'

const CARD_MS = 4500

export default function Room({ party }) {
  const { room, you, youId, isOwner, isHost, chat, send } = party
  const layout = useLayout()
  const kb = useKeyboardInset()
  const player = useRef(null)
  const shell = useRef(null)

  const [full, setFull] = useState(false)
  const [chatOpen, setChatOpen] = useState(false) // overlay chat: phones only
  const [controls, setControls] = useState(true)
  const [quality, setQuality] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffering, setBuffering] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [unread, setUnread] = useState(0)
  const [cards, setCards] = useState([])
  const [menu, setMenu] = useState(null)
  const [leaving, setLeaving] = useState(false)
  const [gameOpen, setGameOpen] = useState(false)
  const [sfxToast, setSfxToast] = useState(null)
  const hideTimer = useRef(null)
  const cardTimers = useRef(new Map())

  const sources = room.sources || []
  const activeSrc = sources[Math.min(quality, sources.length - 1)] || null
  const pending = room.members.filter((m) => !m.approved)
  const members = room.members.filter((m) => m.approved)
  const waitingNames = room.waiting.map((id) => room.members.find((m) => m.id === id)?.name).filter(Boolean)
  // Nothing can happen until the host is back — nobody else can press play.
  const hostMember = room.members.find((m) => m.id === room.ownerId)
  const hostAway = !!hostMember && !hostMember.online && !isOwner

  /**
   * Where the chat goes, decided once:
   *   side   — tablet, beside the film
   *   below  — phone held upright, under the film, filling the rest of the screen
   *   sheet  — phone on its side, where there is no room for anything but the film
   */
  const chatMode = full ? 'none' : layout.split ? 'side' : layout.short ? 'sheet' : 'below'
  const docked = chatMode === 'side'

  /* ------------------------------------------------------------ playback */

  useEffect(() => {
    const p = player.current
    if (!p || !activeSrc) return
    if (room.phase !== 'playing' || room.paused) {
      if (!p.isPaused()) p.pause()
      // Don't drag someone forward while the room is stopped *for* them — a seek
      // throws away the buffer this pause exists to let them build. But only for
      // small corrections: a big gap means being in the wrong place entirely
      // (someone who just walked into a film already well under way), and
      // suppressing *that* seek deadlocks the room — they never move, so they
      // never stop holding it up, so it never resumes.
      const gap = Math.abs(p.time() - room.t)
      const heldForMe = room.pausedBy === null && room.waiting.includes(youId)
      if (gap > BUF.stray || (!heldForMe && gap > 3)) p.seek(room.t)
      return
    }
    const { seek, rate } = syncAction(p.time(), room.t)
    if (seek !== null) p.seek(seek)
    p.rate(rate)
    if (p.isPaused()) {
      p.play()
        .then(() => setBlocked(false))
        .catch(() => p.playMuted().then(() => setBlocked('sound')).catch(() => setBlocked('play')))
    }
  }, [room.phase, room.paused, room.t, room.pausedBy, activeSrc?.id, youId])

  /**
   * What the ticker needs to read, in a ref rather than a dependency array.
   *
   * `room.t` used to be a dependency, and the server pushes room state every
   * second — so this interval was destroyed and recreated every second, and a
   * 1000ms timer reset every ~1000ms almost never fires. No position and no
   * buffer ever reached the server, so after five seconds it believed everyone
   * was five seconds behind, stopped the room, got a single tick while the
   * clock was frozen, started again, and repeated. That was the stutter, and it
   * happened on a perfect connection.
   */
  const live = useRef(null)
  live.current = { phase: room.phase, paused: room.paused, t: room.t, blocked, full }

  useEffect(() => {
    let lastT = -1
    let lastBuf = -1
    let wedged = 0

    const id = setInterval(() => {
      const p = player.current
      if (!p) return
      const { phase, paused, t: roomT, blocked, full } = live.current

      // Seconds in hand, not readyState — see BUF in lib.js.
      const buf = blocked === 'play' ? 0 : p.buffered()
      const now = p.time()
      setBuffering(phase === 'playing' && !paused && buf < BUF.low)

      // A slow connection and a wedged player look identical from out here,
      // except a slow one is still growing its buffer. Only reload when nothing
      // at all is moving — reloading throws away every byte downloaded so far,
      // which on a thin line means it never gets to finish loading anything.
      const moving = now !== lastT || buf > lastBuf + 0.05 || p.loading()
      wedged = phase === 'playing' && !paused && !p.isPaused() && !moving ? wedged + 1 : 0
      lastT = now
      lastBuf = buf
      if (wedged >= 8) {
        wedged = 0
        const at = Math.max(roomT, now)
        p.reload()
        setTimeout(() => { p.seek(at); p.play().catch(() => {}) }, 400)
      }

      send({ type: 'tick', t: now, buf, paused: p.isPaused(), focus: full })
    }, 1000)
    return () => clearInterval(id)
  }, [send])

  /* -------------------------------------------------------- notifications */

  const dropCard = (id) => setCards((c) => c.filter((x) => x.id !== id))
  const armCard = (id) => {
    clearTimeout(cardTimers.current.get(id))
    cardTimers.current.set(id, setTimeout(() => dropCard(id), CARD_MS))
  }

  useEffect(() => {
    party.onChatMessage((msg) => {
      if (msg.from === youId || msg.kind !== 'user') return
      const hidden = full || (chatMode === 'sheet' && !chatOpen)
      if (!hidden) return
      if (!full) return setUnread((n) => n + 1)
      setCards((c) => [...c, msg].slice(-2)) // a phone has room for two, not three
      armCard(msg.id)
    })
  }, [party, full, chatOpen, chatMode, youId]) // eslint-disable-line

  useEffect(() => {
    if (chatMode !== 'sheet' || chatOpen) setUnread(0)
  }, [chat, chatMode, chatOpen])

  useEffect(() => {
    party.onSound(({ id, name, from }) => {
      playSound(id)
      if (from === youId) return
      setSfxToast({ name, at: Date.now() })
      setTimeout(() => setSfxToast((t) => (t && Date.now() - t.at >= 1800 ? null : t)), 2000)
    })
  }, [party, youId])

  // The film is the point; drop the game the moment there's something to watch.
  useEffect(() => { if (!hostAway) setGameOpen(false) }, [hostAway])

  useEffect(() => {
    if (full) return
    cardTimers.current.forEach(clearTimeout)
    cardTimers.current.clear()
    setCards([])
  }, [full])

  /* ------------------------------------------------------------ chrome */

  const playing = room.phase === 'playing' && !room.paused
  const poke = () => {
    if (!full) return
    setControls(true)
    clearTimeout(hideTimer.current)
    if (playing) hideTimer.current = setTimeout(() => setControls(false), 3200)
  }
  useEffect(() => { poke(); return () => clearTimeout(hideTimer.current) }, [full, playing]) // eslint-disable-line

  // Two things have to happen: Razzy's own chrome collapses, and the phone's
  // system bars go. Only the second needs the platform, and only the app can
  // ask for it — requestFullscreen is a no-op in a Capacitor WebView.
  const enterFull = () => {
    setFull(true)
    setChatOpen(false)
    immersive(true)
    shell.current?.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }
  const exitFull = () => {
    setFull(false)
    immersive(false)
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }
  // Leaving the room, or the component, must never strand the bars hidden.
  useEffect(() => () => immersive(false), [])
  useEffect(() => {
    const on = () => { if (!document.fullscreenElement) setFull(false) }
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  /* ------------------------------------------------------------- render */

  const pad = {
    top: full ? 0 : 'var(--top)',
    bottom: full ? 0 : 'var(--bottom)',
    left: 'var(--left)',
    right: 'var(--right)',
  }

  return (
    <div
      ref={shell}
      className={`h-full w-full bg-ink overflow-hidden flex ${docked ? 'flex-row' : 'flex-col'}`}
      style={{ paddingTop: pad.top, paddingLeft: pad.left, paddingRight: pad.right, paddingBottom: pad.bottom }}
    >
      <main className="relative flex-1 min-w-0 min-h-0 flex flex-col">
        {!full && (
          <TopBar
            room={room} members={members} youId={youId} isOwner={isOwner} isHost={isHost}
            onMember={(id) => isHost && id !== youId && setMenu(id)}
            onLeave={() => setLeaving(true)}
            compact={layout.short}
          />
        )}

        {/* The film. Fixed 16:9 while the chat is below it, full bleed otherwise —
            a phone must never letterbox twice. */}
        <div
          className={`relative bg-black overflow-hidden ${full || docked || layout.short ? 'flex-1 min-h-0' : 'w-full'}`}
          style={full || docked || layout.short ? undefined : { aspectRatio: '16 / 9' }}
          onPointerDown={poke}
        >
          {activeSrc ? (
            activeSrc.kind === 'youtube' ? (
              <YouTubePlayer key={activeSrc.id} ref={player} videoId={activeSrc.source} onDuration={setDuration} />
            ) : (
              <FilePlayer key={activeSrc.id} ref={player} src={api.media(activeSrc.source)} onDuration={setDuration} />
            )
          ) : (
            <div className="absolute inset-0 grid place-items-center text-white/40 text-sm px-6 text-center">
              {isHost ? 'Paste a link below to begin' : 'Waiting for the host to pick something…'}
            </div>
          )}

          {blocked && (
            <button
              className={`absolute z-40 grid place-items-center ${
                blocked === 'sound' ? 'bottom-3 left-1/2 -translate-x-1/2' : 'inset-0 bg-black/60'
              }`}
              onClick={() => {
                const p = player.current
                if (!p) return
                if (blocked === 'sound') { p.unmute(); setBlocked(false); return }
                p.play().then(() => setBlocked(false)).catch(() => {})
              }}
            >
              <span className="glass rounded-full px-5 h-11 flex items-center gap-2 text-sm font-semibold pop">
                <Volume2 size={16} />
                {blocked === 'sound' ? 'Tap for sound' : 'Tap to play'}
              </span>
            </button>
          )}

          {buffering && room.phase === 'playing' && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <span className="glass rounded-full px-4 h-10 flex items-center gap-2 text-sm">
                <Loader2 size={15} className="animate-spin text-grass" />
                Buffering…
              </span>
            </div>
          )}

          {waitingNames.length > 0 && room.paused && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 glass rounded-full pl-4 pr-2 h-10 flex items-center gap-2 text-xs pop max-w-[92%]">
              <Loader2 size={13} className="animate-spin text-yellow-400 shrink-0" />
              <span className="truncate">Waiting for {waitingNames.join(', ')}</span>
              {isHost && (
                <button
                  className="press shrink-0 flex items-center gap-1 rounded-full px-2.5 h-7 bg-grass/20 text-grass font-semibold"
                  onClick={() => room.waiting.forEach((id) => send({ type: 'skip', id }))}
                >
                  <SkipForward size={12} />
                  Skip
                </button>
              )}
            </div>
          )}

          {party.countdown !== null && (
            <div className="absolute inset-0 z-40 grid place-items-center bg-black/55">
              <div key={party.countdown} className="text-7xl font-bold text-grass pop">
                {party.countdown === 0 ? 'GO' : party.countdown}
              </div>
            </div>
          )}

          {room.phase === 'ready' && <ReadyCheck room={room} you={you} members={members} send={send} />}

          {/* The host has dropped, and only the host can press play. Rather than
              stare at a frozen frame, there's something to do. */}
          {hostAway && !gameOpen && !full && (
            <div className="absolute inset-x-2 bottom-2 z-30">
              <div className="glass rounded-2xl p-2.5 flex items-center gap-2.5 pop">
                <span className="grid place-items-center rounded-xl bg-grass/20 text-grass shrink-0"
                      style={{ width: 40, height: 40 }}>
                  <Gamepad2 size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold leading-tight truncate">{hostMember.name} dropped out</div>
                  <div className="text-[11px] text-white/45 leading-tight">Play a round while you wait?</div>
                </div>
                <Button kind="primary" className="px-4 shrink-0" style={{ minHeight: 40 }}
                        onClick={() => setGameOpen(true)}>
                  Play
                </Button>
              </div>
            </div>
          )}

          {sfxToast && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-40 glass rounded-full px-3 h-9 flex items-center gap-2 text-xs pop pointer-events-none">
              <Zap size={13} className="text-grass" />
              {sfxToast.name}
            </div>
          )}

          {full && (
            <>
              <div
                className={`absolute right-3 top-1/2 -translate-y-1/2 z-40 transition-opacity duration-300 ${
                  controls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
                style={{ marginRight: 'var(--right)' }}
              >
                <button
                  onClick={exitFull}
                  className="press glass rounded-2xl px-4 flex items-center gap-2 text-xs font-semibold"
                  style={{ height: 'var(--tap)' }}
                >
                  <Minimize2 size={15} />
                  Exit
                </button>
              </div>

              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 w-[min(94vw,24rem)] space-y-2"
                   style={{ marginTop: 'var(--top)' }}>
                {cards.map((msg) => (
                  <NoteCard
                    key={msg.id}
                    msg={msg}
                    onOpen={() => { exitFull(); setChatOpen(true) }}
                    onDismiss={() => dropCard(msg.id)}
                    onHold={() => clearTimeout(cardTimers.current.get(msg.id))}
                    onRelease={() => armCard(msg.id)}
                    onReply={(text) => { send({ type: 'chat', text }); dropCard(msg.id) }}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {!full && (
          <Controls
            room={room} isHost={isHost} send={send} duration={duration}
            sources={sources} active={activeSrc} quality={quality} setQuality={setQuality} player={player}
            onFull={enterFull}
            onChat={chatMode === 'sheet' ? () => setChatOpen(true) : null}
            unread={unread}
            compact={layout.short}
          />
        )}

        {/* Upright phone: the chat is part of the layout, not floating over it. */}
        {chatMode === 'below' && (
          <div className="flex-1 min-h-0">
            <ChatPanel
              chat={chat} pending={pending} isHost={isHost} send={send} youId={youId}
              keyboard={kb} hasSource={sources.length > 0} flush
            />
          </div>
        )}

        {chatMode === 'sheet' && (
          <div
            className={`absolute inset-0 z-50 transition-transform duration-300 ${
              chatOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none'
            }`}
            style={{ transitionTimingFunction: 'var(--ease-spring)' }}
          >
            <ChatPanel
              chat={chat} pending={pending} isHost={isHost} send={send} youId={youId}
              onClose={() => setChatOpen(false)} keyboard={kb} sheet
              hasSource={sources.length > 0}
            />
          </div>
        )}
      </main>

      {docked && (
        <aside className="shrink-0 w-[22rem] xl:w-[26rem] min-w-0 h-full">
          <ChatPanel
            chat={chat} pending={pending} isHost={isHost} send={send} youId={youId}
            keyboard={kb} hasSource={sources.length > 0}
          />
        </aside>
      )}

      {/* Its own window on purpose: the game binds mousedown, touchstart and the
          spacebar to `window` and appends a canvas to `document.body`. Inlined
          here it would swallow every tap in the app; closing the iframe unwinds
          all of it, WebGL context included. */}
      {gameOpen && (
        <div className="fixed inset-0 z-[85] bg-ink">
          <iframe src="/game/" title="Stack" className="w-full h-full border-0" />
          <button
            onClick={() => setGameOpen(false)}
            className="press glass absolute right-3 rounded-2xl px-4 flex items-center gap-2 text-xs font-semibold"
            style={{ top: 'calc(var(--top) + 0.75rem)', height: 'var(--tap)' }}
          >
            <X size={15} />
            Back
          </button>
        </div>
      )}

      {menu && (
        <MemberSheet
          target={room.members.find((m) => m.id === menu)}
          isOwner={isOwner}
          onClose={() => setMenu(null)}
          send={send}
        />
      )}

      {leaving && (
        <LeaveSheet
          room={room} youId={youId} isOwner={isOwner}
          onCancel={() => setLeaving(false)}
          onLeave={() => { setLeaving(false); send({ type: 'leave' }) }}
          onHandOver={(id) => { send({ type: 'promote', id }); send({ type: 'leave' }); setLeaving(false) }}
        />
      )}
    </div>
  )
}

/* --------------------------------------------------------------- pieces */

function TopBar({ room, members, youId, isOwner, isHost, onMember, onLeave, compact }) {
  const [copied, setCopied] = useState(false)
  const size = compact ? 28 : 34
  return (
    <div className="shrink-0 px-2 pt-2 pb-1">
      <div className="glass rounded-2xl px-2 flex items-center gap-2" style={{ height: compact ? 48 : 56 }}>
        <img src="/mark.png" alt="" className="h-6 w-auto shrink-0 ml-1" />
        <button
          className="press shrink-0 rounded-xl px-2.5 h-9 bg-white/6 flex items-center gap-1.5"
          onClick={() => {
            navigator.clipboard?.writeText(room.code).then(() => {
              setCopied(true); setTimeout(() => setCopied(false), 1400)
            }).catch(() => {})
          }}
        >
          <span className="text-sm font-bold tracking-[0.2em] text-grass">{room.code}</span>
          {copied && <Check size={13} className="text-grass" />}
        </button>

        <div className="flex-1 flex items-center gap-2 overflow-x-auto no-scrollbar py-1 px-0.5">
          {members.map((m) => (
            <button key={m.id} className="relative shrink-0 pt-1 pl-1 press" onClick={() => onMember(m.id)}>
              <Avatar m={m} size={size} dim={!m.online} />
              {m.id === room.ownerId && <OwnerBadge size={size} />}
              {m.coHost && m.id !== room.ownerId && <CoHostBadge size={size} />}
              <span className="absolute -bottom-1 -right-1"><Signal ping={m.ping} online={m.online} /></span>
              {m.buffering && <span className="absolute inset-0 top-1 left-1 rounded-full ring-2 ring-yellow-400 animate-pulse" />}
            </button>
          ))}
        </div>

        <span className="text-[11px] text-white/35 shrink-0 tabular-nums">{members.length}/{room.cap}</span>
        <button
          onClick={onLeave}
          className="press shrink-0 grid place-items-center rounded-xl bg-white/6 text-white/60"
          style={{ width: 40, height: 40 }}
          aria-label="Leave"
        >
          <LogOut size={16} />
        </button>
      </div>
    </div>
  )
}

function Controls({ room, isHost, send, duration, sources, active, quality, setQuality, player, onFull, onChat, unread, compact }) {
  const [menu, setMenu] = useState(false)
  const [ytActual, setYtActual] = useState('auto')
  const [ytOwn, setYtOwn] = useState(false)
  const pct = duration ? (Math.min(room.t, duration) / duration) * 100 : 0
  const isYouTube = active?.kind === 'youtube'

  // What YouTube actually settled on. Polled rather than assumed: nothing the
  // page asks for is honoured, so this readout is the only truth available.
  useEffect(() => {
    if (!isYouTube) return
    const read = () => setYtActual(player.current?.quality?.() || 'auto')
    read()
    const id = setInterval(read, 2000)
    return () => clearInterval(id)
  }, [isYouTube, player])

  const pick = (i) => {
    const at = Math.max(room.t, player.current?.time?.() ?? 0)
    setQuality(i)
    setMenu(false)
    setTimeout(() => player.current?.seek?.(at), 600)
  }

  return (
    <div className="shrink-0 relative px-2 pb-2 pt-1">
      <div className="glass rounded-2xl px-2 flex items-center gap-2" style={{ height: compact ? 52 : 60 }}>
        {room.phase === 'idle' ? (
          isHost ? (
            <Button kind="primary" className="px-4 text-sm" style={{ minHeight: 44 }}
                    disabled={!sources.length} onClick={() => send({ type: 'start' })}>
              Start
            </Button>
          ) : (
            <span className="text-xs text-white/45 px-2">Waiting for host</span>
          )
        ) : (
          <button
            onClick={() => send({ type: room.paused ? 'play' : 'pause' })}
            disabled={room.phase !== 'playing'}
            className={`press grid place-items-center rounded-full shrink-0 ${
              room.paused ? 'bg-grass text-black' : 'bg-white/10 text-white'
            }`}
            style={{ width: 44, height: 44 }}
            aria-label={room.paused ? 'Play' : 'Pause'}
          >
            {room.paused ? <Play size={19} fill="currentColor" /> : <Pause size={19} fill="currentColor" />}
          </button>
        )}

        <span className="text-[11px] tabular-nums text-white/50 shrink-0">
          {fmt(room.t)}{duration ? ` / ${fmt(duration)}` : ''}
        </span>

        <div className="relative flex-1 h-1.5 rounded-full bg-white/12 min-w-6">
          <div className="absolute inset-y-0 left-0 rounded-full bg-grass transition-[width] duration-1000 ease-linear"
               style={{ width: `${pct}%` }} />
          {isHost && duration > 0 && (
            <input
              type="range" min={0} max={duration} step={0.5} value={Math.min(room.t, duration)}
              onChange={(e) => send({ type: 'seek', t: Number(e.target.value) })}
              className="absolute -inset-y-4 inset-x-0 w-full opacity-0"
              aria-label="Seek"
            />
          )}
        </div>

        {sources.length > 0 && (
          <button
            onClick={() => setMenu((v) => !v)}
            className="press grid place-items-center rounded-xl bg-white/6 shrink-0"
            style={{ width: 40, height: 40 }}
            aria-label="Quality"
          >
            <Settings size={16} />
          </button>
        )}

        {onChat && (
          <button
            onClick={onChat}
            className="press relative grid place-items-center rounded-xl bg-white/6 shrink-0"
            style={{ width: 40, height: 40 }}
            aria-label="Chat"
          >
            <MessageCircle size={16} />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-grass text-black text-[10px] font-bold grid place-items-center">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        )}

        <button
          onClick={onFull}
          className="press grid place-items-center rounded-xl bg-white/6 shrink-0"
          style={{ width: 40, height: 40 }}
          aria-label="Full screen"
        >
          <Maximize2 size={16} />
        </button>
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div className="absolute bottom-full right-2 mb-2 z-50 glass rounded-2xl p-2 w-60 pop space-y-1">
            <div className="px-2 py-1 text-[11px] uppercase tracking-[0.2em] text-white/35">Quality</div>
            {sources.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1">
                <button
                  onClick={() => pick(i)}
                  className={`press flex-1 flex items-center gap-2 rounded-xl px-3 text-sm text-left ${
                    i === quality ? 'bg-grass/20 text-grass' : ''
                  }`}
                  style={{ minHeight: 44 }}
                >
                  {i === quality ? <Check size={14} strokeWidth={3} /> : <span className="w-3.5" />}
                  <span className="truncate">{s.label}</span>
                </button>
                {isHost && sources.length > 1 && (
                  <button
                    onClick={() => send({ type: 'removeQuality', id: s.id })}
                    className="press grid place-items-center rounded-lg text-white/35"
                    style={{ width: 40, height: 40 }}
                    aria-label="Remove"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
            {isYouTube && (
              <>
                <div className="h-px bg-white/10 my-1" />
                <div className="px-3 py-1 text-sm flex items-center justify-between">
                  <span className="text-white/60">Playing</span>
                  <span className="font-semibold">{YT_LABEL[ytActual] || 'Auto'}</span>
                </div>
                <button
                  onClick={() => { const on = !ytOwn; setYtOwn(on); player.current?.setOwnControls?.(on); setMenu(false) }}
                  className={`press w-full flex items-center gap-2 rounded-xl px-3 text-sm text-left ${
                    ytOwn ? 'bg-grass/20 text-grass' : ''
                  }`}
                  style={{ minHeight: 44 }}
                >
                  {ytOwn ? <Check size={14} strokeWidth={3} /> : <span className="w-3.5" />}
                  YouTube's own controls
                </button>
                <p className="px-3 py-1 text-[11px] text-white/30 leading-snug">
                  YouTube ignores anything this page asks for. Its gear menu is the
                  one place a quality choice sticks.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ReadyCheck({ room, you, members, send }) {
  const notReady = members.filter((m) => m.online && !m.ready)
  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/65 px-5">
      <div className="glass rounded-3xl p-5 w-full max-w-sm text-center space-y-4 pop">
        <h2 className="font-semibold">Ready check</h2>
        <div className="flex flex-wrap justify-center gap-2">
          {members.map((m) => (
            <div key={m.id} className={`flex items-center gap-2 rounded-full pl-1 pr-3 py-1 ${m.ready ? 'bg-grass/25' : 'bg-white/6'}`}>
              <Avatar m={m} size={24} dim={!m.online} />
              <span className="text-xs">{m.name}</span>
              {m.ready && <Check size={12} className="text-grass" strokeWidth={3} />}
            </div>
          ))}
        </div>
        {you?.ready ? (
          <p className="text-sm text-white/50 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            {notReady.length ? `Waiting for ${notReady.map((m) => m.name).join(', ')}` : 'Starting…'}
          </p>
        ) : (
          <Button kind="primary" className="w-full" onClick={() => send({ type: 'ready' })}>
            <Check size={17} strokeWidth={3} />
            Ready
          </Button>
        )}
      </div>
    </div>
  )
}

function ChatPanel({ chat, pending, isHost, send, youId, onClose, keyboard = 0, sheet, flush, hasSource }) {
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const list = useRef(null)
  useEffect(() => { list.current?.scrollTo({ top: 1e9, behavior: 'smooth' }) }, [chat])

  return (
    <div className={`h-full w-full flex flex-col min-h-0 ${sheet ? 'glass-solid' : flush ? 'px-2 pb-1' : 'p-2 pl-0'}`}>
      <div className={`flex-1 flex flex-col min-h-0 ${sheet ? '' : 'glass rounded-2xl overflow-hidden'}`}>
        <div className="flex items-center justify-between px-4 py-2 shrink-0"
             style={sheet ? { paddingTop: 'calc(var(--top) + 0.5rem)' } : undefined}>
          <span className="text-[11px] uppercase tracking-[0.2em] text-white/35">Chat</span>
          {onClose && (
            <button onClick={onClose} className="press grid place-items-center rounded-xl bg-white/6"
                    style={{ width: 38, height: 38 }} aria-label="Close chat">
              <X size={16} />
            </button>
          )}
        </div>

        {/* The host's source box lives up here, well away from the message box.
            Directly above it the two were constantly confused for each other and
            links kept going out as chat. */}
        {isHost && (
          <form
            className="px-2 pb-2 flex gap-2 shrink-0"
            onSubmit={(e) => {
              e.preventDefault()
              if (url.trim()) { send({ type: 'source', url: url.trim() }); setUrl('') }
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="YouTube or PixelDrain link"
              autoCapitalize="off"
              autoCorrect="off"
              className="flex-1 min-w-0 bg-white/6 rounded-full px-4 text-sm outline-none"
              style={{ height: 44 }}
            />
            <Button kind="ghost" type="submit" className="px-3 text-sm" style={{ minHeight: 44 }}>Load</Button>
            {hasSource && (
              <Button
                kind="ghost" type="button" className="px-3" style={{ minHeight: 44 }}
                aria-label="Add as another quality"
                onClick={() => { if (url.trim()) { send({ type: 'addQuality', url: url.trim() }); setUrl('') } }}
              >
                +
              </Button>
            )}
          </form>
        )}

        <div ref={list} className="flex-1 overflow-y-auto no-scrollbar px-3 space-y-2 pb-2 min-h-0">
          {isHost && pending.map((p) => (
            <div key={p.id} className="glass rounded-2xl p-2.5 flex items-center gap-2.5 pop">
              <Avatar m={p} size={34} />
              <span className="flex-1 text-sm leading-tight truncate"><b>{p.name}</b> wants in</span>
              <button onClick={() => send({ type: 'approve', id: p.id, ok: true })}
                      className="press grid place-items-center rounded-full bg-grass/20 text-grass"
                      style={{ width: 40, height: 40 }} aria-label="Accept">
                <Check size={17} strokeWidth={3} />
              </button>
              <button onClick={() => send({ type: 'approve', id: p.id, ok: false })}
                      className="press grid place-items-center rounded-full bg-red-500/20 text-red-300"
                      style={{ width: 40, height: 40 }} aria-label="Decline">
                <X size={17} strokeWidth={3} />
              </button>
            </div>
          ))}

          {chat.map((m) =>
            m.kind === 'system' ? (
              <p key={m.id} className="text-center text-[11px] text-white/30 py-0.5">{m.text}</p>
            ) : (
              <div key={m.id} className={`flex gap-2 rise ${m.from === youId ? 'flex-row-reverse' : ''}`}>
                <Avatar m={m} size={26} />
                <div className={`max-w-[76%] rounded-2xl px-3 py-1.5 ${m.from === youId ? 'bg-grass/25' : 'bg-white/8'}`}>
                  {m.from !== youId && <div className="text-[11px] text-grass/80 font-semibold">{m.name}</div>}
                  <div className="text-sm break-words">{m.text}</div>
                </div>
              </div>
            )
          )}
        </div>

        {/* The composer rides above the keyboard: the WebView itself never resizes,
            so nothing else on screen moves when it opens. */}
        <div
          className="shrink-0 p-2 space-y-2"
          style={{
            paddingBottom: keyboard > 0 ? keyboard + 8 : sheet ? 'calc(var(--bottom) + 0.5rem)' : 8,
            transition: 'padding-bottom 0.18s ease-out',
          }}
        >
          {/* Soundboard: everyone in the party hears it, so it sits with the
              message box rather than behind a menu. */}
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {SOUNDS.map((s) => (
              <button
                key={s.id}
                onClick={() => send({ type: 'sfx', id: s.id })}
                className="press shrink-0 flex items-center gap-1.5 rounded-full px-3 bg-white/6 text-xs"
                style={{ height: 34 }}
              >
                <Zap size={12} className="text-grass" />
                {s.label}
              </button>
            ))}
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!text.trim()) return
              send({ type: 'chat', text: text.trim() })
              setText('')
              send({ type: 'typing', on: false })
            }}
          >
            <input
              value={text}
              onChange={(e) => { setText(e.target.value); send({ type: 'typing', on: !!e.target.value }) }}
              placeholder="Message…"
              className="flex-1 min-w-0 bg-white/8 rounded-full px-4 outline-none focus:bg-white/12"
              style={{ height: 'var(--tap)' }}
            />
            <Button kind="primary" type="submit" className="px-4" aria-label="Send">
              <Send size={17} />
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}

function NoteCard({ msg, onOpen, onDismiss, onReply, onHold, onRelease }) {
  const [reply, setReply] = useState(null)
  const start = useRef(null)
  return (
    <div
      className="glass rounded-3xl p-2.5 pop"
      onPointerDown={(e) => (start.current = e.clientX)}
      onPointerUp={(e) => {
        if (reply !== null) return
        if (start.current !== null && Math.abs(e.clientX - start.current) > 60) onDismiss()
      }}
    >
      <div className="flex items-center gap-2.5" onClick={() => reply === null && onOpen()}>
        <Avatar m={msg} size={34} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-grass font-semibold">{msg.name}</div>
          <div className="text-sm truncate">{msg.text}</div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); reply === null ? (setReply(''), onHold()) : (setReply(null), onRelease()) }}
          className="press text-xs font-semibold text-white/60 px-2 shrink-0"
          style={{ minHeight: 40 }}
        >
          {reply === null ? 'Reply' : 'Cancel'}
        </button>
      </div>
      {reply !== null && (
        <form
          className="mt-2 flex gap-2"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => { e.preventDefault(); if (reply.trim()) onReply(reply.trim()) }}
        >
          <input
            autoFocus value={reply} onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            className="flex-1 min-w-0 bg-white/10 rounded-full px-4 text-sm outline-none"
            style={{ height: 44 }}
          />
          <Button kind="primary" type="submit" className="px-4" style={{ minHeight: 44 }}>
            <Send size={15} />
          </Button>
        </form>
      )}
    </div>
  )
}

/** Bottom sheet: the reachable place for actions on a tall phone. */
function Sheet({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        className="glass-solid w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl sm:mb-6 p-4 pop"
        style={{ paddingBottom: 'calc(var(--bottom) + 1rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-4 sm:hidden" />
        {children}
      </div>
    </div>
  )
}

function MemberSheet({ target, isOwner, onClose, send }) {
  if (!target) return null
  const act = (msg) => { send(msg); onClose() }
  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center gap-3 mb-4">
        <Avatar m={target} size={44} />
        <div className="min-w-0">
          <div className="font-semibold truncate">{target.name}</div>
          <div className="text-xs text-white/40">{target.coHost ? 'Co-host' : 'Watching'}</div>
        </div>
      </div>
      <div className="space-y-2">
        {isOwner && (
          <>
            <Button kind="ghost" className="w-full justify-start px-4 text-yellow-300"
                    onClick={() => act({ type: 'promote', id: target.id })}>
              <Crown size={16} /> Make host
            </Button>
            <Button kind="ghost" className="w-full justify-start px-4 text-sky-300"
                    onClick={() => act({ type: 'cohost', id: target.id, on: !target.coHost })}>
              <Shield size={16} /> {target.coHost ? 'Remove co-host' : 'Make co-host'}
            </Button>
          </>
        )}
        <Button kind="ghost" className="w-full justify-start px-4 text-red-300"
                onClick={() => act({ type: 'kick', id: target.id })}>
          <UserX size={16} /> Remove from party
        </Button>
        <Button kind="plain" className="w-full" onClick={onClose}>Cancel</Button>
      </div>
    </Sheet>
  )
}

function LeaveSheet({ room, youId, isOwner, onCancel, onLeave, onHandOver }) {
  const others = room.members.filter((m) => m.approved && m.online && m.id !== youId)
  const mustHandOver = isOwner && others.length > 0
  return (
    <Sheet onClose={onCancel}>
      <h2 className="font-semibold text-center">{mustHandOver ? 'Pick the next host' : 'Leave the party?'}</h2>
      <p className="text-sm text-white/50 text-center mt-1 mb-4">
        {mustHandOver
          ? 'Someone has to take over before you go.'
          : others.length ? 'You can rejoin with the same code.' : "You're the last one — the party ends."}
      </p>
      {mustHandOver ? (
        <div className="space-y-2 max-h-72 overflow-y-auto no-scrollbar">
          {others.map((m) => (
            <button key={m.id} onClick={() => onHandOver(m.id)}
                    className="press w-full flex items-center gap-3 rounded-2xl p-2 bg-white/6 text-left"
                    style={{ minHeight: 'var(--tap)' }}>
              <Avatar m={m} size={34} />
              <span className="flex-1 truncate text-sm">{m.name}</span>
              <Crown size={15} className="text-yellow-300 shrink-0" />
            </button>
          ))}
        </div>
      ) : (
        <Button kind="danger" className="w-full" onClick={onLeave}>
          <LogOut size={17} /> Leave
        </Button>
      )}
      <Button kind="plain" className="w-full mt-2" onClick={onCancel}>Stay</Button>
    </Sheet>
  )
}
