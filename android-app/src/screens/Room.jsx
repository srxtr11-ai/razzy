import { useEffect, useRef, useState } from 'react'
import { syncAction } from '../../../lib.js'
import {
  Check, Crown, Loader2, LogOut, Maximize2, MessageCircle, Minimize2, Pause, Play,
  Send, Settings, Shield, SkipForward, UserX, Volume2, X,
} from 'lucide-react'
import { api } from '../api.js'
import { FilePlayer, YouTubePlayer } from '../components/players.jsx'
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
  const hideTimer = useRef(null)
  const cardTimers = useRef(new Map())

  const sources = room.sources || []
  const activeSrc = sources[Math.min(quality, sources.length - 1)] || null
  const pending = room.members.filter((m) => !m.approved)
  const members = room.members.filter((m) => m.approved)
  const waitingNames = room.waiting.map((id) => room.members.find((m) => m.id === id)?.name).filter(Boolean)

  // Chat is a column of its own on a tablet, and a sheet over the film on a phone.
  const docked = layout.split && !full

  /* ------------------------------------------------------------ playback */

  useEffect(() => {
    const p = player.current
    if (!p || !activeSrc) return
    if (room.phase !== 'playing' || room.paused) {
      if (!p.isPaused()) p.pause()
      if (Math.abs(p.time() - room.t) > 1.5) p.seek(room.t)
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
  }, [room.phase, room.paused, room.t, activeSrc?.id])

  useEffect(() => {
    let lastT = -1
    let stalled = 0
    const id = setInterval(() => {
      const p = player.current
      if (!p) return
      const starving = (p.ready() < 3 || blocked === 'play') && room.phase === 'playing'
      setBuffering(starving)

      const now = p.time()
      const shouldMove = room.phase === 'playing' && !room.paused && !p.isPaused()
      stalled = shouldMove && now === lastT ? stalled + 1 : 0
      lastT = now
      if (stalled >= 4) {
        stalled = 0
        const at = Math.max(room.t, now)
        p.reload()
        setTimeout(() => { p.seek(at); p.play().catch(() => {}) }, 400)
      }
      send({ type: 'tick', t: now, buffering: starving, paused: p.isPaused(), focus: full })
    }, 1000)
    return () => clearInterval(id)
  }, [send, full, room.phase, room.paused, room.t, blocked])

  /* -------------------------------------------------------- notifications */

  const dropCard = (id) => setCards((c) => c.filter((x) => x.id !== id))
  const armCard = (id) => {
    clearTimeout(cardTimers.current.get(id))
    cardTimers.current.set(id, setTimeout(() => dropCard(id), CARD_MS))
  }

  useEffect(() => {
    party.onChatMessage((msg) => {
      if (msg.from === youId || msg.kind !== 'user') return
      const hidden = full || (!docked && !chatOpen)
      if (!hidden) return
      if (!full) return setUnread((n) => n + 1)
      setCards((c) => [...c, msg].slice(-2)) // a phone has room for two, not three
      armCard(msg.id)
    })
  }, [party, full, chatOpen, docked, youId]) // eslint-disable-line

  useEffect(() => {
    if (docked || chatOpen) setUnread(0)
  }, [chat, docked, chatOpen])

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

  const enterFull = () => {
    setFull(true)
    setChatOpen(false)
    shell.current?.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }
  const exitFull = () => {
    setFull(false)
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }
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
            onChat={docked ? null : () => setChatOpen(true)}
            unread={unread}
            compact={layout.short}
          />
        )}

        {/* Chat over the film on phones. Docked tablets skip this entirely. */}
        {!docked && !full && (
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
  const [levels, setLevels] = useState([])
  const [ytLevel, setYtLevel] = useState('default')
  const pct = duration ? (Math.min(room.t, duration) / duration) * 100 : 0
  const isYouTube = active?.kind === 'youtube'

  useEffect(() => {
    if (!menu || !isYouTube) return
    setLevels(player.current?.qualities?.() || [])
  }, [menu, isYouTube, player])

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
            {isYouTube && levels.length > 0 && (
              <>
                <div className="h-px bg-white/10 my-1" />
                {['default', ...levels].map((lv) => (
                  <button
                    key={lv}
                    onClick={() => { player.current?.setQuality?.(lv); setYtLevel(lv); setMenu(false) }}
                    className={`press w-full flex items-center gap-2 rounded-xl px-3 text-sm text-left ${
                      lv === ytLevel ? 'bg-grass/20 text-grass' : ''
                    }`}
                    style={{ minHeight: 44 }}
                  >
                    {lv === ytLevel ? <Check size={14} strokeWidth={3} /> : <span className="w-3.5" />}
                    {lv === 'default' ? 'Auto' : lv}
                  </button>
                ))}
                <p className="px-3 py-1 text-[11px] text-white/30 leading-snug">
                  YouTube treats this as a hint.
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
          <Button kind="primary" className="w-full flex flex-row gap-2" onClick={() => send({ type: 'ready' })}>
            <Check size={17} strokeWidth={3} />
            Ready
          </Button>
        )}
      </div>
    </div>
  )
}

function ChatPanel({ chat, pending, isHost, send, youId, onClose, keyboard = 0, sheet, hasSource }) {
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const list = useRef(null)
  useEffect(() => { list.current?.scrollTo({ top: 1e9, behavior: 'smooth' }) }, [chat])

  return (
    <div className={`h-full w-full flex flex-col min-h-0 ${sheet ? 'glass-solid' : 'p-2 pl-0'}`}>
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

          {isHost && (
            <form
              className="flex gap-2"
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
            <Button kind="ghost" className="w-full flex flex-row gap-2 justify-start px-4 text-yellow-300"
                    onClick={() => act({ type: 'promote', id: target.id })}>
              <Crown size={16} /> Make host
            </Button>
            <Button kind="ghost" className="w-full flex flex-row gap-2 justify-start px-4 text-sky-300"
                    onClick={() => act({ type: 'cohost', id: target.id, on: !target.coHost })}>
              <Shield size={16} /> {target.coHost ? 'Remove co-host' : 'Make co-host'}
            </Button>
          </>
        )}
        <Button kind="ghost" className="w-full flex flex-row gap-2 justify-start px-4 text-red-300"
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
        <Button kind="danger" className="w-full flex flex-row gap-2" onClick={onLeave}>
          <LogOut size={17} /> Leave
        </Button>
      )}
      <Button kind="plain" className="w-full mt-2" onClick={onCancel}>Stay</Button>
    </Sheet>
  )
}
