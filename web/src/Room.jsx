import { useEffect, useRef, useState } from 'react'
import { BUF, syncAction } from '../../lib.js'
import {
  Check, Copy, Crown, Gamepad2, Loader2, LogOut, Maximize2, Minimize2,
  Pause, Play, Plus, Send, Settings, Shield, SkipForward, UserX, Users, Volume2, X, Zap,
} from 'lucide-react'
import { Avatar, Button, OwnerBadge, Signal, fmt, glare } from './ui.jsx'
import { Player, YT_LABEL } from './players.jsx'
import { SOUNDS, playSound } from './sfx.js'

const CARD_MS = 4500
const SPRING = 'ease-[cubic-bezier(.34,1.2,.64,1)]'

export default function Room({ party, onFriends, friendCount = 0, onPlayGame }) {
  const { room, you, youId, isOwner, chat, send } = party
  const video = useRef(null)
  const [focus, setFocus] = useState(false)
  const [controls, setControls] = useState(true) // only used inside focus mode
  const [cards, setCards] = useState([])
  const [duration, setDuration] = useState(0)
  const [buffering, setBuffering] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [unread, setUnread] = useState(0)
  const [urlDraft, setUrlDraft] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [quality, setQuality] = useState(0) // index into room.sources — a personal choice
  const [sfxToast, setSfxToast] = useState(null)
  const hideTimer = useRef(null)
  const cardTimers = useRef(new Map())
  const shell = useRef(null)

  // Co-hosts get every day-to-day control; only the owner holds the crown.
  const isHost = isOwner || !!you?.coHost
  const sources = room.sources || []
  const active = sources[Math.min(quality, sources.length - 1)] || null
  const pending = room.members.filter((m) => !m.approved)
  const waitingNames = room.waiting.map((id) => room.members.find((m) => m.id === id)?.name).filter(Boolean)
  // Nothing is going to happen until the host is back — nobody else can press play.
  const host = room.members.find((m) => m.id === room.ownerId)
  const hostAway = !!host && !host.online && !isOwner

  /* ---------------------------------------------------------- playback */

  // Room state is the truth; the local player is dragged toward it. Works the
  // same whether that player is our <video> or YouTube's embedded one.
  useEffect(() => {
    const p = video.current
    if (!p || !active) return
    if (room.phase !== 'playing' || room.paused) {
      if (!p.isPaused()) p.pause()
      // Don't drag someone forward while the room is stopped *for* them: they
      // are behind because they can't download fast enough, and a seek throws
      // away the buffer they just spent this pause filling.
      //
      // But only for small corrections. A big gap means being in the wrong place
      // entirely — someone who just walked into a film already 4 minutes in —
      // and suppressing that seek deadlocks the room: they never move, so they
      // never stop holding it up, so it never resumes.
      const gap = Math.abs(p.time() - room.t)
      const heldForMe = room.pausedBy === null && room.waiting.includes(youId)
      if (gap > BUF.stray || (!heldForMe && gap > 3)) p.seek(room.t)
      return
    }
    // SoundCloud and Spotify have no playback rate, so drift can only be fixed
    // by seeking — which is cheap on a three-minute track and ruinous on a film.
    const { seek, rate } = syncAction(p.time(), room.t, p.canRate?.() === false ? 2 : BUF.stray)
    if (seek !== null) p.seek(seek)
    p.rate(rate)
    // Autoplay needs a user gesture on most browsers. Rather than stopping the
    // whole room for one person, fall back to playing muted — they stay in sync
    // and just tap for sound. Only a total refusal counts as blocked.
    if (p.isPaused()) {
      p.play()
        .then(() => setBlocked(false))
        .catch(() => p.playMuted().then(() => setBlocked('sound')).catch(() => setBlocked('play')))
    }
  }, [room.phase, room.paused, room.t, room.pausedBy, active?.id, youId])

  /**
   * What the ticker below needs to read, kept in a ref rather than in its
   * dependency array.
   *
   * This is the single most important line in the file. `room.t` used to be a
   * dependency, and the server pushes new room state every second — so React
   * tore the interval down and built a new one every second, and a 1000ms timer
   * that is reset every ~1000ms almost never fires. Nobody's position or buffer
   * reached the server, so after five seconds the server believed *everyone*
   * was five seconds behind, stopped the room, got one tick while the clock was
   * frozen, started again, and repeated forever. That was the stutter, and it
   * happened on a flawless connection.
   */
  const live = useRef(null)
  live.current = { phase: room.phase, paused: room.paused, t: room.t, blocked, focus }

  useEffect(() => {
    let lastT = -1
    let lastBuf = -1
    let wedged = 0
    let refusing = 0

    const id = setInterval(() => {
      const p = video.current
      if (!p) return
      const { phase, paused, t: roomT, blocked, focus } = live.current

      // Seconds in hand, not readyState — see BUF in lib.js. A player that is
      // blocked outright has nothing in hand as far as the room is concerned;
      // watching muted is still watching, so that doesn't count against us.
      const buf = blocked === 'play' ? 0 : p.buffered()
      const now = p.time()
      setBuffering(phase === 'playing' && !paused && buf < BUF.low)

      // Chrome sometimes suspends a media load and never resumes: readyState 0,
      // network "loading", no socket, film frozen for good. From the outside
      // that looks exactly like a slow connection — except a slow connection is
      // still *growing its buffer*. Only when neither the playhead nor the
      // buffer has moved at all is the player genuinely wedged, and only then is
      // throwing away everything it has downloaded the right move.
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

      // Some embeds report "playing" the instant they're asked and only then
      // discover the browser won't allow it, so play() resolves and nothing
      // happens. The only honest test is whether it is actually running.
      refusing = phase === 'playing' && !paused && p.isPaused() ? refusing + 1 : 0
      if (refusing >= 4 && !blocked) setBlocked('play')

      // null, not 0, when the player genuinely doesn't know where it is yet —
      // the room treats an unknown position as "don't wait for me".
      const known = p.hasPosition?.() !== false
      send({ type: 'tick', t: known ? now : null, buf, paused: p.isPaused(), focus })
    }, 1000)
    return () => clearInterval(id)
  }, [send])

  /* -------------------------------------------------------- soundboard */

  useEffect(() => {
    party.onSound(({ id, name, from }) => {
      playSound(id)
      if (from === youId) return
      setSfxToast({ name, at: Date.now() })
      setTimeout(() => setSfxToast((t) => (t && Date.now() - t.at >= 1800 ? null : t)), 2000)
    })
  }, [party, youId])

  /* ------------------------------------------------- notification cards */

  useEffect(() => {
    party.onChatMessage((msg) => {
      if (msg.from === youId || msg.kind !== 'user') return // system notices aren't repliable
      if (!focus) return setUnread((n) => n + 1)
      // Every message pops — bursts stack rather than queue, oldest falls off.
      setCards((c) => [...c, msg].slice(-3))
      armCard(msg.id)
    })
  }, [party, focus, youId]) // eslint-disable-line react-hooks/exhaustive-deps

  const dropCard = (id) => setCards((c) => c.filter((x) => x.id !== id))

  /** (Re)start a card's auto-dismiss. Held open while you're typing a reply. */
  const armCard = (id) => {
    clearTimeout(cardTimers.current.get(id))
    cardTimers.current.set(id, setTimeout(() => dropCard(id), CARD_MS))
  }
  const holdCard = (id) => {
    clearTimeout(cardTimers.current.get(id))
    cardTimers.current.delete(id)
  }

  useEffect(() => {
    if (focus) return
    cardTimers.current.forEach(clearTimeout)
    cardTimers.current.clear()
    setCards([])
    setUnread(0)
  }, [focus, chat])

  /* --------------------------------------------------------- controls */

  // In focus mode the chrome is gone; a tap brings back the exit chip and bar.
  const playing = room.phase === 'playing' && !room.paused
  const poke = () => {
    if (!focus) return
    setControls(true)
    clearTimeout(hideTimer.current)
    if (playing) hideTimer.current = setTimeout(() => setControls(false), 3000)
  }
  useEffect(() => { poke(); return () => clearTimeout(hideTimer.current) }, [focus, playing]) // eslint-disable-line

  /* ------------------------------------------------------- full screen */

  // Full screen means full screen: the phone's tab bar and address bar go too.
  // The two are one control — entering asks the browser for real fullscreen,
  // and leaving either way leaves both.
  const enterFullScreen = () => {
    setFocus(true)
    shell.current?.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }

  const exitFocus = () => {
    setFocus(false)
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }

  // Escape, the phone's back gesture and the browser's own exit button all
  // leave fullscreen without telling us — follow them out of focus mode.
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFocus(false) }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  /* ------------------------------------------------------------ render */

  return (
    <div ref={shell} className="h-full w-full flex flex-col lg:flex-row bg-ink overflow-hidden">
      {/* ================= stage ================= */}
      <main className="relative flex-1 min-w-0 min-h-0 flex flex-col">
        {/* docked header — collapses in focus mode */}
        <header
          className={`shrink-0 overflow-hidden transition-all duration-500 ${SPRING}
            ${focus ? 'h-0 opacity-0 -translate-y-3' : 'h-16 opacity-100 translate-y-0'}`}
        >
          <TopBar
            room={room} youId={youId} isOwner={isOwner} isHost={isHost} send={send}
            onLeave={() => setLeaving(true)} onFriends={onFriends} friendCount={friendCount}
          />
        </header>

        {/* video surface */}
        <div className="relative flex-1 min-h-0 bg-black" onPointerDown={poke}>
          {active ? (
            <Player
              key={active.id}
              ref={video}
              source={active}
              onDuration={(d) => { setDuration(d); if (isHost) send({ type: 'duration', d }) }}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-white/40 text-sm px-6 text-center">
              {isHost
                ? 'Paste a link above the chat — YouTube, PixelDrain, an .mp4, SoundCloud or Spotify'
                : 'Waiting for the host to pick something…'}
            </div>
          )}

          {blocked && (
            <button
              // 'sound' is playing silently and only needs unmuting, so it must not
              // swallow taps meant for the film; 'play' isn't running at all.
              className={`absolute z-40 grid place-items-center ${
                blocked === 'sound' ? 'bottom-4 left-1/2 -translate-x-1/2' : 'inset-0 bg-black/60'
              }`}
              onClick={() => {
                const p = video.current
                if (!p) return
                if (blocked === 'sound') { p.unmute(); setBlocked(false); return }
                p.play().then(() => setBlocked(false)).catch(() => {})
              }}
            >
              <span className="liquid rounded-full px-6 h-12 flex items-center gap-2 text-sm font-semibold card-in">
                <Volume2 size={16} />
                {blocked === 'sound' ? 'Tap for sound' : 'Tap to play'}
              </span>
            </button>
          )}

          {buffering && room.phase === 'playing' && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <span className="liquid rounded-full px-5 h-11 flex items-center gap-2.5 text-sm">
                <Loader2 size={16} className="animate-spin text-grass" />
                Buffering…
              </span>
            </div>
          )}

          {waitingNames.length > 0 && room.paused && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 liquid rounded-full pl-5 pr-2 h-11 flex items-center gap-3 text-sm card-in">
              <Loader2 size={15} className="animate-spin text-yellow-400 shrink-0" />
              <span className="whitespace-nowrap">Waiting for {waitingNames.join(', ')}…</span>
              {isOwner && (
                <button
                  className="press text-grass font-semibold flex items-center gap-1.5 rounded-full px-3 h-8 bg-grass/15 hover:bg-grass/25"
                  onClick={() => room.waiting.forEach((id) => send({ type: 'skip', id }))}
                >
                  <SkipForward size={13} />
                  Skip
                </button>
              )}
            </div>
          )}

          {party.countdown !== null && (
            <div className="absolute inset-0 z-40 grid place-items-center bg-black/75">
              <div key={party.countdown} className="text-8xl font-bold text-grass card-in drop-shadow-[0_8px_30px_rgba(34,197,94,.5)]">
                {party.countdown === 0 ? 'GO' : party.countdown}
              </div>
            </div>
          )}

          {room.phase === 'ready' && <ReadyCheck room={room} you={you} send={send} />}

          {/* The host has dropped and only the host can press play, so the room
              is going nowhere until they're back. Rather than stare at a frozen
              frame, there's something to do. */}
          {hostAway && !focus && (
            <div className="absolute inset-x-4 bottom-4 z-30 flex justify-center">
              <div className="liquid rounded-3xl px-4 py-3 flex items-center gap-3 card-in max-w-sm">
                <span className="grid place-items-center w-10 h-10 rounded-2xl bg-grass/20 text-grass shrink-0">
                  <Gamepad2 size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold leading-tight">{host.name} dropped out</div>
                  <div className="text-xs text-white/45 leading-tight">Play a round while you wait?</div>
                </div>
                <Button kind="primary" className="shrink-0 px-4 h-10" onClick={onPlayGame}>
                  Play
                </Button>
              </div>
            </div>
          )}

          {sfxToast && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 liquid rounded-full px-4 h-10 flex items-center gap-2 text-xs card-in pointer-events-none">
              <Zap size={14} className="text-grass" />
              {sfxToast.name}
            </div>
          )}

          {/* focus: exit chip on the right. The wrapper owns the positioning so the
              button's own backdrop-filter can't affect where it lands. */}
          <div
            className={`absolute right-4 top-1/2 z-40 -translate-y-1/2 transition-all duration-500 ${SPRING}
              ${focus && controls ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8 pointer-events-none'}`}
          >
            <button
              onClick={exitFocus}
              onPointerMove={glare.onPointerMove}
              className="liquid glare press rounded-2xl pl-3 pr-4 h-11 flex items-center gap-2 text-xs font-semibold"
            >
              <Minimize2 size={15} />
              Exit
            </button>
          </div>

          {/* focus: glass notification stack */}
          {focus && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,26rem)] space-y-2">
              {cards.map((msg, i) => (
                <NoteCard
                  key={msg.id}
                  msg={msg}
                  depth={cards.length - 1 - i}
                  onOpen={exitFocus}
                  onDismiss={() => dropCard(msg.id)}
                  onHold={() => holdCard(msg.id)}
                  onRelease={() => armCard(msg.id)}
                  onReply={(text) => {
                    send({ type: 'chat', text })
                    dropCard(msg.id)
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* docked control bar — collapses in focus mode */}
        <div
          className={`shrink-0 overflow-hidden transition-all duration-500 ${SPRING}
            ${focus ? 'max-h-0 opacity-0 translate-y-4' : 'max-h-48 opacity-100 translate-y-0'}`}
        >
          <Controls
            room={room} you={you} isHost={isHost} send={send} duration={duration}
            onFocus={enterFullScreen} unread={unread}
            sources={sources} active={active} quality={quality} setQuality={setQuality} player={video}
          />
        </div>
      </main>

      {leaving && (
        <LeaveSheet
          room={room} youId={youId} isOwner={isOwner}
          onCancel={() => setLeaving(false)}
          onLeave={() => { setLeaving(false); send({ type: 'leave' }) }}
          onHandOver={(id) => { send({ type: 'promote', id }); send({ type: 'leave' }); setLeaving(false) }}
        />
      )}

      {/* ================= docked chat ================= */}
      {/* min-w-0/min-h-0: a flex item defaults to min-size:auto, so the panel's own
          content would hold it open no matter what width we animate to. */}
      <aside
        className={`shrink-0 overflow-hidden min-w-0 min-h-0 transition-all duration-500 ${SPRING}
          ${focus
            ? 'h-0 lg:h-auto lg:w-0 opacity-0'
            : 'h-[42%] lg:h-auto lg:w-[22rem] xl:w-[24rem] opacity-100'}`}
      >
        <ChatPanel
          chat={chat} pending={pending} isOwner={isOwner} isHost={isHost} send={send} youId={youId}
          hasSource={sources.length > 0}
          urlDraft={urlDraft} setUrlDraft={setUrlDraft}
        />
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------ pieces */

/**
 * Leaving. A host with other people still in the room has to pass the crown
 * first — otherwise the party sits paused with nobody able to press play. So
 * rather than refusing, we ask who should take over and do both in one go.
 */
function LeaveSheet({ room, youId, isOwner, onCancel, onLeave, onHandOver }) {
  const others = room.members.filter((m) => m.approved && m.online && m.id !== youId)
  const mustHandOver = isOwner && others.length > 0

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 px-6" onClick={onCancel}>
      <div className="liquid rounded-[2rem] p-6 w-full max-w-sm space-y-4 card-in" onClick={(e) => e.stopPropagation()}>
        <div className="text-center space-y-1">
          <h2 className="text-lg font-semibold">{mustHandOver ? 'Pick the next host' : 'Leave the party?'}</h2>
          <p className="text-sm text-white/50">
            {mustHandOver
              ? "You're the host, so someone has to take over before you go."
              : others.length
                ? 'You can rejoin with the same code.'
                : "You're the last one here — the party ends."}
          </p>
        </div>

        {mustHandOver ? (
          <div className="space-y-2 max-h-64 overflow-y-auto no-scrollbar">
            {others.map((m) => (
              <button
                key={m.id}
                onClick={() => onHandOver(m.id)}
                className="press w-full flex items-center gap-3 rounded-2xl p-2 bg-white/6 hover:bg-white/12 text-left"
              >
                <Avatar m={m} size={34} />
                <span className="flex-1 text-sm truncate">{m.name}</span>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-yellow-300">
                  <Crown size={13} />
                  Hand over &amp; leave
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Button kind="danger" className="w-full flex items-center justify-center gap-2" onClick={onLeave}>
            <LogOut size={16} />
            Leave
          </Button>
        )}

        <button onClick={onCancel} className="press w-full text-sm text-white/50 hover:text-white/80 py-1">
          Stay
        </button>
      </div>
    </div>
  )
}

function ReadyCheck({ room, you, send }) {
  const notReady = room.members.filter((m) => m.approved && m.online && !m.ready)
  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/80 px-6">
      <div className="liquid glare rounded-[2rem] p-6 w-full max-w-sm text-center space-y-4 card-in" onPointerMove={glare.onPointerMove}>
        <h2 className="text-lg font-semibold">Ready check</h2>
        <div className="flex flex-wrap justify-center gap-2">
          {room.members.filter((m) => m.approved).map((m) => (
            <div
              key={m.id}
              className={`flex items-center gap-2 rounded-full pl-1 pr-3 py-1 transition-all duration-500 ${SPRING}
                ${m.ready ? 'bg-grass/25 scale-100' : 'bg-white/5 scale-95'}`}
            >
              <Avatar m={m} size={24} dim={!m.online} />
              <span className="text-xs">{m.name}</span>
              {m.ready && <Check size={13} className="text-grass" strokeWidth={3} />}
            </div>
          ))}
        </div>
        {you?.ready ? (
          <p className="text-sm text-white/50 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            {notReady.length ? `Waiting for ${notReady.map((m) => m.name).join(', ')}` : 'Starting…'}
          </p>
        ) : (
          <Button
            kind="primary"
            className="w-full flex items-center justify-center gap-2"
            onClick={() => send({ type: 'ready' })}
          >
            <Check size={17} strokeWidth={3} />
            Ready
          </Button>
        )}
      </div>
    </div>
  )
}

/** Copying the code is how people actually invite each other — make it one tap. */
function CodeChip({ code }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(code).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => {})
      }}
      className="press shrink-0 flex items-center gap-2 rounded-full pl-3 pr-2.5 h-9 bg-white/6 hover:bg-white/12"
      title="Copy party code"
    >
      <span className="text-sm font-bold tracking-[0.25em] text-grass">{code}</span>
      {copied ? <Check size={14} className="text-grass" /> : <Copy size={14} className="text-white/40" />}
    </button>
  )
}

function TopBar({ room, youId, isOwner, isHost, send, onLeave, onFriends, friendCount = 0 }) {
  const [menu, setMenu] = useState(null) // member id whose actions are open
  const target = room.members.find((m) => m.id === menu)

  return (
    <div className="h-full px-3 pt-3 relative">
      {/* host's per-member actions; tap-driven so it works on a phone */}
      {target && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div className="absolute left-3 right-3 top-full mt-2 z-50 flex justify-center">
            <div className="liquid rounded-2xl p-2 flex items-center gap-2 card-in">
              <Avatar m={target} size={28} />
              <span className="text-sm px-1 max-w-32 truncate">{target.name}</span>
              {isOwner && (
                <>
                  <button
                    className="press flex items-center gap-1.5 rounded-xl px-3 h-9 text-sm font-semibold bg-yellow-400/15 text-yellow-300 hover:bg-yellow-400/25"
                    onClick={() => { send({ type: 'promote', id: target.id }); setMenu(null) }}
                  >
                    <Crown size={14} />
                    Make host
                  </button>
                  <button
                    className={`press flex items-center gap-1.5 rounded-xl px-3 h-9 text-sm font-semibold
                      ${target.coHost
                        ? 'bg-sky-400/20 text-sky-300 hover:bg-sky-400/30'
                        : 'bg-white/8 text-white/70 hover:bg-white/15'}`}
                    onClick={() => { send({ type: 'cohost', id: target.id, on: !target.coHost }); setMenu(null) }}
                  >
                    <Shield size={14} />
                    {target.coHost ? 'Remove co-host' : 'Make co-host'}
                  </button>
                </>
              )}
              <button
                className="press flex items-center gap-1.5 rounded-xl px-3 h-9 text-sm font-semibold bg-red-500/15 text-red-300 hover:bg-red-500/25"
                onClick={() => { send({ type: 'kick', id: target.id }); setMenu(null) }}
              >
                <UserX size={14} />
                Remove
              </button>
            </div>
          </div>
        </>
      )}

      <div className="liquid glare rounded-full px-3 flex items-center gap-2.5 h-full" onPointerMove={glare.onPointerMove}>
        {/* 0.76:1 mark — height-locked so it can't stretch */}
        <img src="/mark.png" alt="" width={160} height={221} className="h-7 w-auto shrink-0 ml-1" />
        <CodeChip code={room.code} />
        {/* py-2 keeps the owner badge and signal bars inside the scroll box — a
            tight container clipped them in half. */}
        <div className="flex-1 flex items-center gap-2.5 overflow-x-auto overflow-y-hidden no-scrollbar py-2">
          {room.members.filter((m) => m.approved).map((m) => (
            <button
              key={m.id}
              className="relative shrink-0 pt-1 pl-1 press"
              title={m.name}
              onClick={() => isHost && m.id !== youId && setMenu(menu === m.id ? null : m.id)}
            >
              <Avatar m={m} size={32} dim={!m.online} />
              {m.id === room.ownerId && <OwnerBadge size={32} />}
              {m.coHost && m.id !== room.ownerId && (
                <span className="absolute top-0 left-0 grid place-items-center rounded-full bg-sky-400 text-black shadow-[0_1px_5px_rgba(0,0,0,.7)] w-[19px] h-[19px]" title="Co-host">
                  <Shield size={11} strokeWidth={2.75} fill="currentColor" />
                </span>
              )}
              <span className="absolute -bottom-1 -right-1"><Signal ping={m.ping} online={m.online} /></span>
              {m.buffering && <span className="absolute inset-0 top-1 left-1 rounded-full ring-2 ring-yellow-400 animate-pulse" />}
              {m.focus && <span className="absolute top-1 -right-0.5 w-2 h-2 rounded-full bg-grass ring-2 ring-black/60" title="In focus mode" />}
            </button>
          ))}
        </div>

        <span className="text-xs text-white/40 shrink-0">
          {room.members.filter((m) => m.approved).length}/{room.cap}
        </span>

        {/* Inviting or calling a friend into this party starts here. */}
        <button
          onClick={onFriends}
          className="press relative shrink-0 grid place-items-center w-9 h-9 rounded-full bg-white/6 hover:bg-white/12 text-white/60"
          title="Friends"
          aria-label="Friends"
        >
          <Users size={16} />
          {friendCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-grass text-black text-[10px] font-bold grid place-items-center">
              {friendCount}
            </span>
          )}
        </button>

        <button
          onClick={onLeave}
          className="press shrink-0 grid place-items-center w-9 h-9 rounded-full bg-white/6 hover:bg-red-500/25 hover:text-red-300 text-white/60"
          title="Leave the party"
          aria-label="Leave the party"
        >
          <LogOut size={16} />
        </button>
      </div>
    </div>
  )
}

/**
 * Quality is a personal choice — it's about your bandwidth, not the room's, so
 * switching never touches anyone else. Two things can appear here:
 *   · renditions the host added (a 1080p alongside the 720p), and
 *   · YouTube's own levels, when YouTube is what's playing.
 */
function QualityMenu({ sources, active, quality, setQuality, player, isHost, send, roomTime }) {
  const [open, setOpen] = useState(false)
  const [ytActual, setYtActual] = useState('auto')
  const [ytOwn, setYtOwn] = useState(false)

  const isYouTube = active?.kind === 'youtube'

  // What YouTube actually settled on. Polled rather than assumed, because
  // nothing the page asks for is honoured — this readout is the only truth.
  useEffect(() => {
    if (!isYouTube) return
    const read = () => setYtActual(player.current?.quality?.() || 'auto')
    read()
    const id = setInterval(read, 2000)
    return () => clearInterval(id)
  }, [isYouTube, player])

  if (!sources.length) return null

  const pick = (i) => {
    // keep the viewer where they were; the room clock is the truth anyway
    const at = Math.max(roomTime, player.current?.time?.() ?? 0)
    setQuality(i)
    setOpen(false)
    setTimeout(() => player.current?.seek?.(at), 600)
  }

  return (
    <div className="relative shrink-0">
      <Button kind="ghost" onClick={() => setOpen(!open)} className="flex items-center gap-2 px-3">
        <Settings size={15} />
        <span className="hidden md:inline text-xs">
          {isYouTube ? YT_LABEL[ytActual] || 'Auto' : active?.label}
        </span>
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-3 z-50 liquid rounded-2xl p-2 w-56 card-in space-y-1">
            <div className="px-2 pt-1 pb-0.5 text-[11px] uppercase tracking-[0.2em] text-white/35">Quality</div>

            {sources.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1">
                <button
                  onClick={() => pick(i)}
                  className={`press flex-1 flex items-center gap-2 rounded-xl px-3 h-9 text-sm text-left
                    ${i === quality ? 'bg-grass/20 text-grass' : 'hover:bg-white/10'}`}
                >
                  {i === quality ? <Check size={14} strokeWidth={3} /> : <span className="w-3.5" />}
                  <span className="truncate">{s.label}</span>
                </button>
                {isHost && sources.length > 1 && (
                  <button
                    onClick={() => send({ type: 'removeQuality', id: s.id })}
                    className="press w-8 h-8 grid place-items-center rounded-lg text-white/35 hover:text-red-300 hover:bg-red-500/15"
                    aria-label={`Remove ${s.label}`}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}

            {/* YouTube's quality is YouTube's business — see below. */}
            {isYouTube && (
              <>
                <div className="h-px bg-white/10 my-1" />
                <div className="px-2 pb-0.5 text-[11px] uppercase tracking-[0.2em] text-white/35">YouTube</div>
                <div className="px-3 pb-1 text-sm flex items-center justify-between">
                  <span className="text-white/60">Playing</span>
                  <span className="font-semibold">{YT_LABEL[ytActual] || 'Auto'}</span>
                </div>
                <button
                  onClick={() => { const on = !ytOwn; setYtOwn(on); player.current?.setOwnControls?.(on); setOpen(false) }}
                  className={`press w-full flex items-center gap-2 rounded-xl px-3 h-9 text-sm text-left
                    ${ytOwn ? 'bg-grass/20 text-grass' : 'hover:bg-white/10'}`}
                >
                  {ytOwn ? <Check size={14} strokeWidth={3} /> : <span className="w-3.5" />}
                  YouTube's own controls
                </button>
                <p className="px-3 py-1 text-[11px] leading-snug text-white/30">
                  YouTube picks the quality itself and ignores anything this page
                  asks for. Its own gear menu is the one place the choice sticks,
                  so this puts it on the video. The room still drives playback.
                </p>
              </>
            )}

            {isHost && (
              <p className="px-3 py-1 text-[11px] leading-snug text-white/30">
                Paste another link above the chat to add a version.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Controls({ room, you, isHost, send, duration, onFocus, unread, sources, active, quality, setQuality, player }) {
  const typing = room.members.filter((m) => m.typing && m.id !== you?.id).map((m) => m.name)
  const pct = duration ? (Math.min(room.t, duration) / duration) * 100 : 0

  return (
    <div className="p-3">
      <div className="liquid glare rounded-full h-14 px-3 flex items-center gap-3" onPointerMove={glare.onPointerMove}>
        {room.phase === 'idle' ? (
          isHost ? (
            <Button kind="primary" disabled={!sources.length} onClick={() => send({ type: 'start' })}>Start</Button>
          ) : (
            <span className="text-sm text-white/50 px-3">Waiting for host</span>
          )
        ) : (
          <Button
            kind={room.paused ? 'primary' : 'ghost'}
            onClick={() => send({ type: room.paused ? 'play' : 'pause' })}
            disabled={room.phase !== 'playing'}
            className="flex items-center gap-2"
          >
            {room.paused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}
            {room.paused ? 'Play' : 'Pause'}
          </Button>
        )}

        <span className="text-xs tabular-nums text-white/50 shrink-0">
          {fmt(room.t)}{duration ? ` / ${fmt(duration)}` : ''}
        </span>

        {/* scrubber: the owner drags, everyone else just watches it fill */}
        <div className="relative flex-1 h-1.5 rounded-full bg-white/10 min-w-8">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-grass transition-[width] duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
          />
          {/* isHost, not isOwner — which wasn't a prop here at all, so this line
              threw a ReferenceError and took the whole room down with it. */}
          {isHost && duration > 0 && (
            <input
              type="range" min={0} max={duration} step={0.5} value={Math.min(room.t, duration)}
              onChange={(e) => send({ type: 'seek', t: Number(e.target.value) })}
              className="absolute -inset-y-3 inset-x-0 w-full opacity-0 cursor-pointer"
              aria-label="Seek"
            />
          )}
        </div>

        <span className="hidden sm:block max-w-32 truncate text-xs text-grass/70">
          {typing.length ? `${typing.join(', ')} typing…` : ''}
        </span>

        <QualityMenu
          sources={sources} active={active} quality={quality} setQuality={setQuality}
          player={player} isHost={isHost} send={send} roomTime={room.t}
        />

        <Button kind="ghost" onClick={onFocus} className="relative shrink-0 flex items-center gap-2">
          <Maximize2 size={15} />
          <span className="hidden sm:inline">Full screen</span>
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-grass text-black text-[11px] font-bold grid place-items-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </div>
    </div>
  )
}

/** Docked panel — part of the layout, not floating over the film. */
function ChatPanel({ chat, pending, isOwner, isHost, send, youId, urlDraft, setUrlDraft, hasSource }) {
  const [text, setText] = useState('')
  const list = useRef(null)
  useEffect(() => { list.current?.scrollTo({ top: 1e9, behavior: 'smooth' }) }, [chat])

  const submit = (e) => {
    e.preventDefault()
    if (!text.trim()) return
    send({ type: 'chat', text: text.trim() })
    setText('')
    send({ type: 'typing', on: false })
  }

  return (
    <div className="h-full w-full p-3 pt-0 lg:pt-3 lg:pl-0 flex flex-col min-h-0">
      <div className="liquid rounded-[1.75rem] flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="px-5 pt-3 pb-1 shrink-0">
          <span className="text-[11px] uppercase tracking-[0.2em] text-white/35">Chat</span>
        </div>

        {/* The host's source box lives up here, away from the message box.
            Sitting directly above it, the two were constantly confused for each
            other and links went out as chat. */}
        {isHost && (
          <form
            className="px-2 pb-2 flex gap-2 shrink-0"
            onSubmit={(e) => {
              e.preventDefault()
              if (urlDraft.trim()) { send({ type: 'source', url: urlDraft.trim() }); setUrlDraft('') }
            }}
          >
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="Paste a link — YouTube, PixelDrain, SoundCloud, Spotify"
              className="flex-1 bg-white/6 rounded-full px-4 h-10 text-sm outline-none focus:bg-white/12 transition min-w-0"
            />
            <Button kind="ghost" type="submit" className="h-10 px-4 shrink-0 bg-white/6">
              Load
            </Button>
            {/* Same film, different rendition — appends a quality option rather
                than replacing what everyone is watching. */}
            {hasSource && (
              <Button
                kind="ghost"
                type="button"
                className="h-10 px-3 shrink-0 bg-white/6"
                title="Add this link as another quality option"
                onClick={() => {
                  if (urlDraft.trim()) { send({ type: 'addQuality', url: urlDraft.trim() }); setUrlDraft('') }
                }}
              >
                <Plus size={15} />
              </Button>
            )}
          </form>
        )}

        <div ref={list} className="flex-1 overflow-y-auto no-scrollbar px-3 space-y-2 pb-2 min-h-0">
          {isHost &&
            pending.map((p) => (
              <div key={p.id} className="liquid-lite rounded-2xl p-3 flex items-center gap-3 card-in">
                <Avatar m={p} size={34} />
                <span className="flex-1 text-sm leading-tight">
                  <b>{p.name}</b> wants to join
                </span>
                <button
                  className="press shrink-0 grid place-items-center w-9 h-9 rounded-full bg-grass/20 text-grass hover:bg-grass/30"
                  onClick={() => send({ type: 'approve', id: p.id, ok: true })}
                  aria-label={`Accept ${p.name}`}
                >
                  <Check size={17} strokeWidth={3} />
                </button>
                <button
                  className="press shrink-0 grid place-items-center w-9 h-9 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  onClick={() => send({ type: 'approve', id: p.id, ok: false })}
                  aria-label={`Decline ${p.name}`}
                >
                  <X size={17} strokeWidth={3} />
                </button>
              </div>
            ))}

          {chat.map((m) =>
            m.kind === 'system' ? (
              <p key={m.id} className="text-center text-[11px] text-white/30 py-1">{m.text}</p>
            ) : (
              <div key={m.id} className={`flex gap-2 rise ${m.from === youId ? 'flex-row-reverse' : ''}`}>
                <Avatar m={m} size={26} />
                <div
                  className={`max-w-[78%] rounded-2xl px-3 py-1.5 ${m.from === youId ? 'bg-grass/25' : 'bg-white/8'}`}
                  style={{ boxShadow: 'inset 0 1px 1px rgba(255,255,255,.12)' }}
                >
                  {m.from !== youId && <div className="text-[11px] text-grass/80 font-semibold">{m.name}</div>}
                  <div className="text-sm break-words">{m.text}</div>
                </div>
              </div>
            )
          )}
        </div>

        {/* Soundboard: everyone in the party hears it, so it belongs next to the
            message box rather than buried in a menu. */}
        <div className="px-2 pt-1 flex gap-1.5 shrink-0 overflow-x-auto no-scrollbar">
          {SOUNDS.map((s) => (
            <button
              key={s.id}
              onClick={() => send({ type: 'sfx', id: s.id })}
              className="press shrink-0 flex items-center gap-1.5 rounded-full h-8 px-3 bg-white/6 hover:bg-white/12 text-xs"
              title={`Play "${s.label}" for the party`}
            >
              <Zap size={12} className="text-grass" />
              {s.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="p-2 flex gap-2 shrink-0">
          <input
            value={text}
            onChange={(e) => { setText(e.target.value); send({ type: 'typing', on: !!e.target.value }) }}
            placeholder="Message…"
            className="flex-1 bg-white/8 rounded-full px-4 h-11 text-sm outline-none focus:bg-white/12 transition min-w-0"
          />
          <Button kind="primary" type="submit" className="px-4 shrink-0" aria-label="Send message">
            <Send size={16} />
          </Button>
        </form>
      </div>
    </div>
  )
}

/** iOS-style glass card. Tap body -> leave focus into chat. Reply inline -> stay in focus. */
function NoteCard({ msg, depth, onOpen, onDismiss, onReply, onHold, onRelease }) {
  const [reply, setReply] = useState(null)
  const start = useRef(null)

  const openReply = () => { setReply(''); onHold() }   // stop the card expiring under you
  const cancelReply = () => { setReply(null); onRelease() }

  return (
    <div
      className={`liquid glare rounded-[1.75rem] p-3 card-in transition-transform duration-500 ${SPRING}`}
      style={{ transform: `scale(${1 - depth * 0.04})`, opacity: 1 - depth * 0.2 }}
      onPointerMove={glare.onPointerMove}
      onPointerDown={(e) => (start.current = e.clientX)}
      onPointerUp={(e) => {
        if (reply !== null) return // never swipe away a card you're typing into
        if (start.current !== null && Math.abs(e.clientX - start.current) > 60) onDismiss()
      }}
    >
      <div className="flex items-center gap-3 cursor-pointer" onClick={() => reply === null && onOpen()}>
        <Avatar m={msg} size={38} />
        <div className="min-w-0 flex-1 py-0.5">
          <div className="text-[11px] text-grass font-semibold leading-tight">{msg.name}</div>
          <div className="text-sm leading-snug line-clamp-2 break-words">{msg.text}</div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); reply === null ? openReply() : cancelReply() }}
          className="press text-xs font-semibold text-white/60 px-2 shrink-0"
        >
          {reply === null ? 'Reply' : 'Cancel'}
        </button>
      </div>

      {reply !== null && (
        <form
          className="mt-2 flex gap-2 rise"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => { e.preventDefault(); if (reply.trim()) onReply(reply.trim()) }}
        >
          <input
            autoFocus
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply without leaving…"
            className="flex-1 bg-white/10 rounded-full px-4 h-10 text-sm outline-none min-w-0"
          />
          <Button kind="primary" type="submit" className="px-4" aria-label="Send reply">
            <Send size={16} />
          </Button>
        </form>
      )}
    </div>
  )
}
