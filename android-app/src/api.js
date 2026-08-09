/**
 * Everything that leaves the device.
 *
 * The app ships no server of its own — it is a client for the Razzy instance on
 * Railway, over the same REST + websocket surface the website uses. The base URL
 * is overridable so a debug build can point at a laptop.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_BASE = 'https://razzy.up.railway.app'

/** Worth nothing by the time a dropped connection comes back. */
const TRANSIENT = new Set(['tick', 'typing', 'pong'])

export const api = {
  get base() {
    return localStorage.getItem('razzy.server') || DEFAULT_BASE
  },
  set base(v) {
    if (v) localStorage.setItem('razzy.server', v.replace(/\/+$/, ''))
    else localStorage.removeItem('razzy.server')
  },
  get isDefault() {
    return !localStorage.getItem('razzy.server')
  },
  url: (p) => `${api.base}${p}`,
  wsUrl: () => `${api.base.replace(/^http/, 'ws')}/ws`,

  health: () => fetch(api.url('/api/v1/health')).then((r) => r.json()),
  party: (code) =>
    fetch(api.url(`/api/v1/party/${encodeURIComponent(code)}`)).then((r) =>
      r.ok ? r.json() : null),
  resolve: (url) =>
    fetch(api.url(`/api/v1/resolve?url=${encodeURIComponent(url)}`)).then((r) =>
      r.ok ? r.json() : null),
  uploadAvatar: (dataUrl) =>
    fetch(api.url('/api/v1/avatar'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    }).then((r) => {
      if (!r.ok) throw new Error('upload failed')
      return r.json()
    }),
  /** Room sources arrive as paths for proxied files; make them absolute. */
  media: (s) => (s?.startsWith('/') ? api.url(s) : s),
}

/**
 * Avatars are stored as `/avatars/x.jpg`, which resolves against the server on
 * the website and against `capacitor://localhost` in here — where it is nothing
 * at all. Anyone who joined from a browser had a broken picture in the app. Fix
 * it once, on the way in, rather than at every place one is drawn.
 */
const absolutise = (o) => (o && o.avatar ? { ...o, avatar: api.media(o.avatar) } : o)
const absolutiseAll = (list) => (Array.isArray(list) ? list.map(absolutise) : list)

/**
 * The handful of things only the Android shell can do. All no-ops in a browser,
 * so the same code runs in `npm run dev` without a special case.
 */
const native = () => (typeof window !== 'undefined' ? window.RazzyNative : null)

/** Hide or restore the system bars — the Fullscreen API is a no-op in a WebView. */
export const immersive = (on) => {
  try { native()?.setImmersive?.(!!on) } catch {}
}

/**
 * Hold the process open while a party is running. Android otherwise freezes a
 * backgrounded app, which kills the socket, drifts playback out of sync and
 * means a friend's call never arrives.
 */
export const keepAlive = (on, code = '') => {
  try { native()?.setKeepAlive?.(!!on, code) } catch {}
}

// Notification ids have to be numbers and have to be stable, so that a second
// message from the same person replaces the first instead of stacking.
const noteId = (s) => {
  let h = 0
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0
  return Math.abs(h) % 100000
}

/**
 * `callId` turns this into a ringing notification with Answer and Decline on it.
 * Without those a call was only a nudge to go and open the app and find the
 * button — which is not what a ringing phone is supposed to mean.
 */
export const notify = (tag, title, body, urgent = false, callId = null) => {
  try { native()?.notify?.(noteId(tag), String(title), String(body), !!urgent, callId) } catch {}
}
export const clearNote = (tag) => {
  try { native()?.cancelNote?.(noteId(tag)) } catch {}
}

/** An Answer or Decline tapped in the shade, if one is waiting. */
export const takeAction = () => {
  try { return native()?.takeAction?.() || '' } catch { return '' }
}
export const hasShell = () => !!native()

/* ------------------------------------------------------------- identity */

const ls = {
  get: (k, d = null) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d }
  },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
}

export const identity = () => {
  let id = ls.get('razzy.id')
  if (!id) { id = crypto.randomUUID(); ls.set('razzy.id', id) }
  return { id, name: ls.get('razzy.name', ''), avatar: ls.get('razzy.avatar', null) }
}
export const remember = (name, avatar) => {
  ls.set('razzy.name', name)
  ls.set('razzy.avatar', avatar)
}

const lastParty = {
  get: () => ls.get('razzy.party', null),
  set: (c) => ls.set('razzy.party', c),
  clear: () => localStorage.removeItem('razzy.party'),
}

/* ---------------------------------------------------------------- party */

/**
 * Owns the socket. Phones suspend it constantly — screen off, app backgrounded,
 * wifi handing over to mobile data — so it reconnects forever and walks back
 * into the same seat by id.
 */
export function useParty() {
  const [room, setRoom] = useState(null)
  const [youId, setYouId] = useState(null)
  const [chat, setChat] = useState([])
  const [error, setError] = useState(null)
  const [countdown, setCountdown] = useState(null)
  const [connected, setConnected] = useState(false)
  const [declined, setDeclined] = useState(false)

  // People, as opposed to parties. These outlive any room.
  const [me, setMe] = useState(() => ls.get('razzy.me', null))
  const [friends, setFriends] = useState([])
  const [threads, setThreads] = useState({})
  const [ring, setRing] = useState(null)
  const [calling, setCalling] = useState(null)
  const [invites, setInvites] = useState([])
  const [challenge, setChallenge] = useState(null)
  const [match, setMatch] = useState(null)

  const ws = useRef(null)
  const intent = useRef(null)
  const inRoom = useRef(false)
  const onChat = useRef(() => {})
  const onSfx = useRef(() => {})
  const heard = useRef(0) // when the server last said anything at all
  const pending = useRef([]) // sent while offline, waiting for a socket

  /**
   * Anything sent while the socket is between connections used to vanish
   * silently, so a button pressed a second after the app came back from the
   * background did nothing at all. That is exactly when Answer gets pressed —
   * the phone has been asleep, the socket is still catching up — which is why
   * the call buttons looked dead.
   *
   * Positions and typing flags are dropped rather than queued: replaying where
   * you were ten seconds ago is worse than saying nothing.
   */
  const send = useCallback((msg) => {
    const s = ws.current
    if (s?.readyState === 1) return s.send(JSON.stringify(msg))
    if (TRANSIENT.has(msg?.type)) return
    pending.current.push(msg)
    if (pending.current.length > 20) pending.current.shift()
  }, [])

  const flush = (sock) => {
    const held = pending.current
    pending.current = []
    for (const msg of held) sock.send(JSON.stringify(msg))
  }

  const withMembers = (r) => (r ? { ...r, members: absolutiseAll(r.members) } : r)

  /**
   * Notify only when the app isn't the thing you're looking at. A notification
   * for a message already on screen is noise, and this app's whole complaint
   * history is about noise.
   */
  const away = (tag, title, body) => {
    if (document.visibilityState === 'visible') return
    notify(tag, title, body, false)
  }

  const open = useCallback(() => {
    let sock
    try { sock = new WebSocket(api.wsUrl()) } catch { return }
    ws.current = sock

    sock.onopen = () => {
      setConnected(true)
      // Who we are, before anything else — presence, friend requests and calls
      // all have to reach a phone sitting in the lobby.
      sock.send(JSON.stringify({ type: 'hello', ...identity() }))
      if (!intent.current) {
        const code = lastParty.get()
        if (code) intent.current = { type: 'join', code, ...identity() }
      }
      if (intent.current) sock.send(JSON.stringify(intent.current))
      flush(sock)
    }

    sock.onclose = () => {
      setConnected(false)
      setTimeout(() => { if (ws.current === sock) open() }, 1200)
    }

    sock.onmessage = (e) => {
      heard.current = Date.now()
      const m = JSON.parse(e.data)
      if (m.type === 'ping') return sock.send(JSON.stringify({ type: 'pong', ts: m.ts }))
      if (m.type === 'sfx') return onSfx.current(m)
      if (m.type === 'joined') {
        setYouId(m.you)
        setRoom(withMembers(m.room))
        setChat(absolutiseAll(m.chat || []))
        intent.current = { type: 'join', code: m.room.code, ...identity(), id: m.you }
        lastParty.set(m.room.code)
        inRoom.current = true
        return
      }
      if (m.type === 'state') return setRoom(withMembers(m.room))
      if (m.type === 'chat') {
        setChat((c) => [...c.slice(-199), absolutise(m.msg)])
        onChat.current(m.msg)
        return
      }

      /* --- people ---------------------------------------------------- */
      if (m.type === 'me' || m.type === 'restored') {
        const user = absolutise(m.user)
        ls.set('razzy.me', user)
        setMe(user)
        if (m.type === 'restored') {
          ls.set('razzy.id', user.id)
          ls.set('razzy.name', user.name)
          if (user.avatar) ls.set('razzy.avatar', user.avatar)
          location.reload()
        }
        return
      }
      if (m.type === 'friends') return setFriends(absolutiseAll(m.friends))
      if (m.type === 'dms') return setThreads((t) => ({ ...t, [m.with]: m.msgs }))
      if (m.type === 'dm') {
        setThreads((t) => ({ ...t, [m.with]: [...(t[m.with] || []), m.msg].slice(-200) }))
        if (m.msg.from !== identity().id) away(`dm-${m.msg.from}`, m.msg.name, m.msg.text)
        return
      }
      if (m.type === 'friendreq') {
        away(`req-${m.from.id}`, m.from.name, 'wants to be friends')
        return
      }
      if (m.type === 'friendok') {
        away(`req-${m.from.id}`, m.from.name, 'accepted your friend request')
        return
      }
      if (m.type === 'invite') {
        setInvites((v) => [...v.filter((x) => x.from.id !== m.from.id), m])
        away(`inv-${m.from.id}`, m.from.name, `invited you to party ${m.code}`)
        return
      }
      /* a game between two friends */
      if (m.type === 'challenge') {
        setChallenge(m)
        away(`game-${m.from.id}`, m.from.name, 'challenges you at Stack')
        return
      }
      if (m.type === 'challenged') {
        return setMatch({ matchId: m.matchId, opponentId: m.to, waitingForThem: true })
      }
      if (m.type === 'gamestart') {
        setChallenge(null)
        return setMatch({ matchId: m.matchId, opponent: m.opponent, scores: {}, playing: true })
      }
      if (m.type === 'gamescore') {
        return setMatch((g) => (g?.matchId === m.matchId ? { ...g, scores: m.scores } : g))
      }
      if (m.type === 'gameresult') {
        return setMatch((g) =>
          g?.matchId === m.matchId ? { ...g, scores: m.scores, winner: m.winner, done: true } : g)
      }
      if (m.type === 'gameend') {
        setChallenge((c) => (c?.matchId === m.matchId ? null : c))
        return setMatch((g) => (g?.matchId === m.matchId ? null : g))
      }

      if (m.type === 'ring') {
        setRing(m)
        // Urgent, and answerable without opening the app first.
        notify(`call-${m.callId}`, m.from.name, 'is calling you into a party', true, m.callId)
        return
      }
      if (m.type === 'calling') return setCalling(m)
      if (m.type === 'callend') {
        clearNote(`call-${m.callId}`)
        setRing((r) => (r?.callId === m.callId ? null : r))
        setCalling((c) => (c?.callId === m.callId ? null : c))
        return
      }
      if (m.type === 'calljoin') {
        clearNote(`call-${m.callId}`)
        setRing(null)
        intent.current = { type: 'join', code: m.code, ...identity() }
        sock.send(JSON.stringify(intent.current))
        return
      }
      if (m.type === 'left') {
        lastParty.clear(); intent.current = null; inRoom.current = false
        setRoom(null); setChat([]); setYouId(null)
        return
      }
      if (m.type === 'countdown') return setCountdown(m.n)
      if (m.type === 'declined') {
        setDeclined(true); lastParty.clear(); intent.current = null
        ws.current = null; sock.close(); return
      }
      if (m.type === 'error') {
        if (!inRoom.current) { intent.current = null; lastParty.clear() }
        return setError(m.error)
      }
    }
  }, [])

  useEffect(() => {
    open()
    return () => { const s = ws.current; ws.current = null; s?.close() }
  }, [open])

  // Coming back from the background with a socket the OS quietly killed is the
  // single most common way a phone client goes silent. Check on resume.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return
      const s = ws.current
      if (!s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) open()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
    }
  }, [open])

  /**
   * …and the other half of it: wifi handing over to mobile data leaves a socket
   * that is open as far as readyState is concerned and dead as far as anything
   * else is. No close event ever comes, so the app sits there "connected"
   * forever. The server pings every three seconds, so silence is the only
   * honest signal.
   */
  useEffect(() => {
    const id = setInterval(() => {
      const s = ws.current
      if (!s || !heard.current) return
      if (s.readyState === 1 && Date.now() - heard.current > 10_000) {
        heard.current = 0
        s.close() // onclose reconnects and walks us back into the same seat
      }
    }, 3000)
    return () => clearInterval(id)
  }, [])

  /**
   * Answer and Decline on the call notification come back through here. The
   * activity can't act on them itself — answering means using the socket, and
   * the socket is in this page.
   */
  useEffect(() => {
    /**
     * Collect an Answer or Decline tapped in the shade. Pulled rather than
     * pushed: the activity parks the decision and this asks for it once the page
     * exists, so tapping Answer with the app closed can't lose the race.
     */
    const pull = () => {
      const parked = takeAction()
      if (!parked) return
      const [action, callId] = parked.split(' ')
      if (!callId) return
      send({ type: action === 'answer' ? 'callAnswer' : 'callDecline', callId })
      clearNote(`call-${callId}`)
      // Either way the ring is dealt with — answering goes straight into the
      // party, so showing the Answer button again would be asking twice.
      setRing((r) => (r?.callId === callId ? null : r))
    }
    window.__razzyPull = pull
    pull()
    document.addEventListener('visibilitychange', pull)
    return () => {
      delete window.__razzyPull
      document.removeEventListener('visibilitychange', pull)
    }
  }, [send])

  useEffect(() => {
    if (countdown === null) return
    const t = setTimeout(() => setCountdown(null), countdown === 0 ? 700 : 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const create = (name, avatar, cap) => {
    intent.current = { type: 'create', ...identity(), name, avatar, cap }
    send(intent.current)
  }
  const join = (code, name, avatar) => {
    intent.current = { type: 'join', code, ...identity(), name, avatar }
    send(intent.current)
  }

  const you = room?.members.find((m) => m.id === youId) || null
  const isOwner = !!room && room.ownerId === youId

  // Being in a party is what earns the process the right to stay alive.
  useEffect(() => {
    keepAlive(!!room, room?.code || '')
    return () => keepAlive(false)
  }, [room?.code]) // eslint-disable-line

  return {
    room, you, youId, isOwner,
    isHost: isOwner || !!you?.coHost,
    chat, error, setError, countdown, connected, declined,
    onChatMessage: (fn) => { onChat.current = fn },
    onSound: (fn) => { onSfx.current = fn },
    send, create, join,

    /* people */
    me, friends, threads, ring, calling, invites, challenge, match,
    challengeFriend: (id) => send({ type: 'challenge', id }),
    acceptChallenge: (matchId) => send({ type: 'challengeAccept', matchId }),
    declineChallenge: (matchId) => send({ type: 'challengeDecline', matchId }),
    quitMatch: (matchId) => { send({ type: 'challengeCancel', matchId }); setMatch(null); setChallenge(null) },
    reportScore: (matchId, score) => send({ type: 'gameScore', matchId, score }),
    openThread: (id) => send({ type: 'dmHistory', id }),
    sendDm: (id, text) => send({ type: 'dm', id, text }),
    addFriend: (code) => send({ type: 'friendAdd', code }),
    acceptFriend: (id) => send({ type: 'friendAccept', id }),
    removeFriend: (id) => send({ type: 'friendRemove', id }),
    invite: (id) => send({ type: 'invite', id }),
    call: (id) => send({ type: 'call', id }),
    answerCall: (callId) => send({ type: 'callAnswer', callId }),
    declineCall: (callId) => send({ type: 'callDecline', callId }),
    cancelCall: (callId) => send({ type: 'callCancel', callId }),
    dismissInvite: (id) => setInvites((v) => v.filter((x) => x.from.id !== id)),
    restore: (code, key) => send({ type: 'restore', code, key }),
    /** Friends see this name before you've joined anything, so don't make them wait. */
    setProfile: (name, avatar) => {
      remember(name, avatar)
      send({ type: 'hello', ...identity() })
    },
    joinCode: (code) => {
      intent.current = { type: 'join', code, ...identity() }
      send(intent.current)
    },
  }
}

/** Send an already-cropped square data URL and get back an absolute URL. */
export async function pickAvatar(dataUrl) {
  const { url } = await api.uploadAvatar(dataUrl)
  return api.media(url)
}
