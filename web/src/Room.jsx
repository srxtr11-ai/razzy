import { useEffect, useRef, useState } from 'react'
import { syncAction } from '../../lib.js'
import { Check, Copy, Loader2, Maximize2, Pause, Play, Send, SkipForward, UserX, X } from 'lucide-react'
import { Avatar, Button, OwnerBadge, Signal, fmt, glare } from './ui.jsx'

const CARD_MS = 4500
const SPRING = 'ease-[cubic-bezier(.34,1.2,.64,1)]'

export default function Room({ party }) {
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
  const hideTimer = useRef(null)
  const cardTimers = useRef(new Map())

  const pending = room.members.filter((m) => !m.approved)
  const waitingNames = room.waiting.map((id) => room.members.find((m) => m.id === id)?.name).filter(Boolean)

  /* ---------------------------------------------------------- playback */

  // Room state is the truth; the local element is dragged toward it.
  useEffect(() => {
    const v = video.current
    if (!v || !room.source) return
    if (room.phase !== 'playing' || room.paused) {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - room.t) > 1.5) v.currentTime = room.t
      return
    }
    const { seek, rate } = syncAction(v.currentTime, room.t)
    if (seek !== null) v.currentTime = seek
    v.playbackRate = rate
    // Autoplay is blocked without a user gesture on most browsers; ask for one.
    if (v.paused) v.play().then(() => setBlocked(false)).catch(() => setBlocked(true))
  }, [room.phase, room.paused, room.t, room.source])

  // Report position, buffer health and focus state once a second.
  useEffect(() => {
    const id = setInterval(() => {
      const v = video.current
      if (!v) return
      const starving = v.readyState < 3 && room.phase === 'playing'
      setBuffering(starving)
      send({ type: 'tick', t: v.currentTime, buffering: starving, paused: v.paused, focus })
    }, 1000)
    return () => clearInterval(id)
  }, [send, focus, room.phase])

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

  const exitFocus = () => setFocus(false)

  /* ------------------------------------------------------------ render */

  return (
    <div className="h-full w-full flex flex-col lg:flex-row bg-ink overflow-hidden">
      {/* ================= stage ================= */}
      <main className="relative flex-1 min-w-0 min-h-0 flex flex-col">
        {/* docked header — collapses in focus mode */}
        <header
          className={`shrink-0 overflow-hidden transition-all duration-500 ${SPRING}
            ${focus ? 'h-0 opacity-0 -translate-y-3' : 'h-16 opacity-100 translate-y-0'}`}
        >
          <TopBar room={room} youId={youId} isOwner={isOwner} send={send} />
        </header>

        {/* video surface */}
        <div className="relative flex-1 min-h-0 bg-black" onPointerDown={poke}>
          {room.source ? (
            <video
              ref={video}
              src={room.source}
              className="absolute inset-0 w-full h-full object-contain bg-black"
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onWaiting={() => setBuffering(true)}
              onPlaying={() => setBuffering(false)}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-white/40 text-sm px-6 text-center">
              {isOwner ? 'Paste a PixelDrain link below to begin' : 'Waiting for the host to pick something…'}
            </div>
          )}

          {blocked && (
            <button
              className="absolute inset-0 z-40 grid place-items-center bg-black/60"
              onClick={() => video.current?.play().then(() => setBlocked(false)).catch(() => {})}
            >
              <span className="liquid rounded-full px-6 h-12 grid place-items-center text-sm font-semibold card-in">
                Tap to join the audio
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
            <div className="absolute inset-0 z-40 grid place-items-center bg-black/50 backdrop-blur-md">
              <div key={party.countdown} className="text-8xl font-bold text-grass card-in drop-shadow-[0_8px_30px_rgba(34,197,94,.5)]">
                {party.countdown === 0 ? 'GO' : party.countdown}
              </div>
            </div>
          )}

          {room.phase === 'ready' && <ReadyCheck room={room} you={you} send={send} />}

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
              <X size={15} />
              Exit focus
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
            room={room} you={you} isOwner={isOwner} send={send} duration={duration}
            onFocus={() => setFocus(true)} unread={unread}
            urlDraft={urlDraft} setUrlDraft={setUrlDraft}
          />
        </div>
      </main>

      {/* ================= docked chat ================= */}
      {/* min-w-0/min-h-0: a flex item defaults to min-size:auto, so the panel's own
          content would hold it open no matter what width we animate to. */}
      <aside
        className={`shrink-0 overflow-hidden min-w-0 min-h-0 transition-all duration-500 ${SPRING}
          ${focus
            ? 'h-0 lg:h-auto lg:w-0 opacity-0'
            : 'h-[42%] lg:h-auto lg:w-[22rem] xl:w-[24rem] opacity-100'}`}
      >
        <ChatPanel chat={chat} pending={pending} isOwner={isOwner} send={send} youId={youId} />
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------ pieces */

function ReadyCheck({ room, you, send }) {
  const notReady = room.members.filter((m) => m.approved && m.online && !m.ready)
  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-md px-6">
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

function TopBar({ room, youId, isOwner, send }) {
  return (
    <div className="h-full px-3 pt-3">
      <div className="liquid glare rounded-full px-3 flex items-center gap-3 h-full" onPointerMove={glare.onPointerMove}>
        <CodeChip code={room.code} />
        {/* py-2 keeps the owner badge and signal bars inside the scroll box — a
            tight container clipped them in half. */}
        <div className="flex-1 flex items-center gap-2.5 overflow-x-auto overflow-y-hidden no-scrollbar py-2">
          {room.members.filter((m) => m.approved).map((m) => (
            <div key={m.id} className="relative group shrink-0 pt-1 pl-1" title={m.name}>
              <Avatar m={m} size={32} dim={!m.online} />
              {m.id === room.ownerId && <OwnerBadge size={32} />}
              <span className="absolute -bottom-1 -right-1"><Signal ping={m.ping} online={m.online} /></span>
              {m.buffering && <span className="absolute inset-0 top-1 left-1 rounded-full ring-2 ring-yellow-400 animate-pulse" />}
              {m.focus && <span className="absolute top-1 -right-0.5 w-2 h-2 rounded-full bg-grass ring-2 ring-black/60" title="In focus mode" />}
              {isOwner && m.id !== youId && (
                <button
                  onClick={() => send({ type: 'kick', id: m.id })}
                  className="absolute inset-0 top-1 left-1 grid place-items-center rounded-full bg-red-500/85 opacity-0 group-hover:opacity-100 transition"
                  aria-label={`Remove ${m.name}`}
                >
                  <UserX size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        <span className="text-xs text-white/40 shrink-0">
          {room.members.filter((m) => m.approved).length}/{room.cap}
        </span>
      </div>
    </div>
  )
}

function Controls({ room, you, isOwner, send, duration, onFocus, unread, urlDraft, setUrlDraft }) {
  const typing = room.members.filter((m) => m.typing && m.id !== you?.id).map((m) => m.name)
  const pct = duration ? (Math.min(room.t, duration) / duration) * 100 : 0

  return (
    <div className="p-3 space-y-2">
      {isOwner && (
        <form
          className="liquid rounded-full h-12 flex items-center gap-2 pl-4 pr-2"
          onSubmit={(e) => { e.preventDefault(); if (urlDraft.trim()) { send({ type: 'source', url: urlDraft.trim() }); setUrlDraft('') } }}
        >
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://pixeldrain.com/u/…"
            className="flex-1 bg-transparent text-sm outline-none min-w-0"
          />
          <Button kind="ghost" type="submit">Load</Button>
        </form>
      )}

      <div className="liquid glare rounded-full h-14 px-3 flex items-center gap-3" onPointerMove={glare.onPointerMove}>
        {room.phase === 'idle' ? (
          isOwner ? (
            <Button kind="primary" disabled={!room.source} onClick={() => send({ type: 'start' })}>Start</Button>
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
          {isOwner && duration > 0 && (
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

        <Button kind="ghost" onClick={onFocus} className="relative shrink-0 flex items-center gap-2">
          <Maximize2 size={15} />
          Focus
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
function ChatPanel({ chat, pending, isOwner, send, youId }) {
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

        <div ref={list} className="flex-1 overflow-y-auto no-scrollbar px-3 space-y-2 pb-2 min-h-0">
          {isOwner &&
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
