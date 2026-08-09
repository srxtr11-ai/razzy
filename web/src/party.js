import { useCallback, useEffect, useRef, useState } from 'react'

const ls = {
  get: (k, d = null) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d }
  },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
}

export const identity = () => {
  let id = ls.get('wp.id')
  if (!id) { id = crypto.randomUUID(); ls.set('wp.id', id) }
  return { id, name: ls.get('wp.name', ''), avatar: ls.get('wp.avatar', null) }
}
export const remember = (name, avatar) => { ls.set('wp.name', name); ls.set('wp.avatar', avatar) }

// Which party this browser was last in, so a refresh walks straight back in
// instead of dumping you at the lobby while the party carries on without you.
const lastParty = {
  get: () => ls.get('wp.party', null),
  set: (code) => ls.set('wp.party', code),
  clear: () => localStorage.removeItem('wp.party'),
}

const WS_URL = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

/**
 * Owns the socket. Reconnects forever and re-enters the party with the same id,
 * so a phone locking its screen doesn't lose your seat.
 */
export function useParty() {
  const [room, setRoom] = useState(null)
  const [youId, setYouId] = useState(null)
  const [chat, setChat] = useState([])
  const [error, setError] = useState(null)
  const [countdown, setCountdown] = useState(null)
  const [joinReqs, setJoinReqs] = useState([])
  const [connected, setConnected] = useState(false)
  const [declined, setDeclined] = useState(false)

  // People, as opposed to parties. These outlive any room.
  const [me, setMe] = useState(() => ls.get('wp.me', null))
  const [friends, setFriends] = useState([])
  const [threads, setThreads] = useState({}) // friendId -> messages
  const [ring, setRing] = useState(null) // someone is calling us
  const [calling, setCalling] = useState(null) // we are calling someone
  const [invites, setInvites] = useState([])
  const [challenge, setChallenge] = useState(null) // someone wants a game
  const [match, setMatch] = useState(null) // the game itself

  const ws = useRef(null)
  const intent = useRef(null) // what to (re)send on open
  const inRoom = useRef(false) // have we ever actually got in? (ref: `open` never re-reads state)
  const onChat = useRef(() => {})
  const onSfx = useRef(() => {})
  const onDm = useRef(() => {})
  const onSocial = useRef(() => {}) // friend requests, invites, incoming calls
  const heard = useRef(0) // when the server last said anything at all

  const send = useCallback((msg) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(msg))
  }, [])

  const open = useCallback(() => {
    const sock = new WebSocket(WS_URL())
    ws.current = sock

    sock.onopen = () => {
      setConnected(true)
      // Announce who we are before anything else. Friend requests, presence and
      // calls all have to reach someone sitting in the lobby, so the server
      // needs to know this socket exists independently of any party.
      sock.send(JSON.stringify({ type: 'hello', ...identity() }))
      // On a fresh page load there's no intent yet — walk back into the party
      // this browser was in. The server still has our seat under the same id.
      if (!intent.current) {
        const code = lastParty.get()
        if (code) intent.current = { type: 'join', code, ...identity() }
      }
      if (intent.current) sock.send(JSON.stringify(intent.current))
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
        setRoom(m.room)
        setChat(m.chat || [])
        // reconnects rejoin by id instead of re-requesting entry
        intent.current = { type: 'join', code: m.room.code, ...identity(), id: m.you }
        lastParty.set(m.room.code)
        inRoom.current = true
        return
      }
      if (m.type === 'state') return setRoom(m.room)
      if (m.type === 'chat') {
        setChat((c) => [...c.slice(-199), m.msg])
        onChat.current(m.msg)
        return
      }
      if (m.type === 'left') { // we asked to go, and the server let us
        lastParty.clear()
        intent.current = null
        inRoom.current = false
        setRoom(null); setChat([]); setYouId(null)
        return
      }
      /* --- people ---------------------------------------------------- */
      if (m.type === 'me' || m.type === 'restored') {
        // Kept locally too, so the friend code is on screen before the socket
        // has said anything.
        ls.set('wp.me', m.user)
        setMe(m.user)
        if (m.type === 'restored') {
          ls.set('wp.id', m.user.id)
          ls.set('wp.name', m.user.name)
          if (m.user.avatar) ls.set('wp.avatar', m.user.avatar)
          location.reload()
        }
        return
      }
      if (m.type === 'friends') return setFriends(m.friends)
      if (m.type === 'dms') return setThreads((t) => ({ ...t, [m.with]: m.msgs }))
      if (m.type === 'dm') {
        setThreads((t) => ({ ...t, [m.with]: [...(t[m.with] || []), m.msg].slice(-200) }))
        onDm.current(m)
        return
      }
      if (m.type === 'friendreq' || m.type === 'friendok') return onSocial.current(m)
      if (m.type === 'invite') {
        setInvites((v) => [...v.filter((x) => x.from.id !== m.from.id), m])
        onSocial.current(m)
        return
      }
      /* a game between two friends */
      if (m.type === 'challenge') { setChallenge(m); onSocial.current(m); return }
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

      if (m.type === 'ring') { setRing(m); onSocial.current(m); return }
      if (m.type === 'calling') return setCalling(m)
      if (m.type === 'callend') {
        setRing((r) => (r?.callId === m.callId ? null : r))
        setCalling((c) => (c?.callId === m.callId ? null : c))
        return
      }
      // We answered — walk straight into their party, which is the whole point.
      if (m.type === 'calljoin') {
        setRing(null)
        const { id, name, avatar } = identity()
        intent.current = { type: 'join', code: m.code, id, name, avatar }
        sock.send(JSON.stringify(intent.current))
        return
      }

      if (m.type === 'joinreq') return setJoinReqs((q) => [...q, m])
      if (m.type === 'countdown') return setCountdown(m.n)
      if (m.type === 'declined') {
        setDeclined(true); lastParty.clear(); intent.current = null; ws.current = null; sock.close(); return
      }
      if (m.type === 'error') {
        // the remembered party is gone (server restart, party ended) — don't
        // retry it forever, just fall back to the lobby
        if (!inRoom.current) { intent.current = null; lastParty.clear() }
        return setError(m.error)
      }
    }
  }, [])

  useEffect(() => {
    open()
    return () => { const s = ws.current; ws.current = null; s?.close() }
  }, [open])

  /**
   * A socket can die without ever firing `close` — a laptop sleeping, wifi
   * handing over to mobile data, anything that drops the connection without a
   * FIN. The tab then sits there believing it is connected, forever. The server
   * pings every 3s, so silence is the only reliable tell: ten seconds of it and
   * the connection is dead whatever readyState claims.
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

  useEffect(() => {
    if (countdown === null) return
    const t = setTimeout(() => setCountdown(null), countdown === 0 ? 700 : 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const create = (name, avatar, cap) => {
    const { id } = identity()
    intent.current = { type: 'create', id, name, avatar, cap }
    send(intent.current)
  }

  const join = (code, name, avatar) => {
    const { id } = identity()
    intent.current = { type: 'join', code, id, name, avatar }
    send(intent.current)
  }

  const leave = () => {
    intent.current = null
    lastParty.clear()
    inRoom.current = false
    setRoom(null)
    setChat([])
    setYouId(null)
    ws.current?.close()
  }

  const you = room?.members.find((m) => m.id === youId) || null
  const isOwner = !!room && room.ownerId === youId

  return {
    room, you, youId, isOwner, chat, error, setError, countdown, connected, declined,
    joinReqs, clearJoinReq: (id) => setJoinReqs((q) => q.filter((r) => r.id !== id)),
    onChatMessage: (fn) => { onChat.current = fn },
    onSound: (fn) => { onSfx.current = fn },
    onDirectMessage: (fn) => { onDm.current = fn },
    onSocial: (fn) => { onSocial.current = fn },
    send, create, join, leave,

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
    /**
     * Push a name or picture the moment it's typed, rather than waiting for the
     * first party. Otherwise you add a friend and they see "Guest".
     */
    setProfile: (name, avatar) => {
      remember(name, avatar)
      send({ type: 'hello', ...identity() })
    },
    /** Walk into a friend's party without typing the code. */
    joinCode: (code) => {
      const { id, name, avatar } = identity()
      intent.current = { type: 'join', code, id, name, avatar }
      send(intent.current)
    },
  }
}

/** Send an already-cropped square data URL. No multipart, no bucket. */
export async function uploadAvatar(dataUrl) {
  const res = await fetch('/api/avatar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  })
  if (!res.ok) throw new Error('upload failed')
  return (await res.json()).url
}
