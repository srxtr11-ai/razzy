/**
 * Everything that leaves the device.
 *
 * The app ships no server of its own — it is a client for the Razzy instance on
 * Railway, over the same REST + websocket surface the website uses. The base URL
 * is overridable so a debug build can point at a laptop.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_BASE = 'https://razzy.up.railway.app'

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

  const ws = useRef(null)
  const intent = useRef(null)
  const inRoom = useRef(false)
  const onChat = useRef(() => {})

  const send = useCallback((msg) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(msg))
  }, [])

  const open = useCallback(() => {
    let sock
    try { sock = new WebSocket(api.wsUrl()) } catch { return }
    ws.current = sock

    sock.onopen = () => {
      setConnected(true)
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
      const m = JSON.parse(e.data)
      if (m.type === 'ping') return sock.send(JSON.stringify({ type: 'pong', ts: m.ts }))
      if (m.type === 'joined') {
        setYouId(m.you)
        setRoom(m.room)
        setChat(m.chat || [])
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

  return {
    room, you, youId, isOwner,
    isHost: isOwner || !!you?.coHost,
    chat, error, setError, countdown, connected, declined,
    onChatMessage: (fn) => { onChat.current = fn },
    send, create, join,
  }
}

/** Downscale to 128px before upload — phone cameras produce 4 MB selfies. */
export async function pickAvatar(file) {
  const bitmap = await createImageBitmap(file)
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const scale = Math.max(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  const { url } = await api.uploadAvatar(c.toDataURL('image/jpeg', 0.8))
  return api.media(url)
}
