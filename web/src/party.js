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

  const ws = useRef(null)
  const intent = useRef(null) // what to (re)send on open
  const onChat = useRef(() => {})

  const send = useCallback((msg) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(msg))
  }, [])

  const open = useCallback(() => {
    const sock = new WebSocket(WS_URL())
    ws.current = sock

    sock.onopen = () => {
      setConnected(true)
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
        // reconnects rejoin by id instead of re-requesting entry
        intent.current = { type: 'join', code: m.room.code, id: m.you, ...identity() }
        return
      }
      if (m.type === 'state') return setRoom(m.room)
      if (m.type === 'chat') {
        setChat((c) => [...c.slice(-199), m.msg])
        onChat.current(m.msg)
        return
      }
      if (m.type === 'joinreq') return setJoinReqs((q) => [...q, m])
      if (m.type === 'countdown') return setCountdown(m.n)
      if (m.type === 'declined') { setDeclined(true); intent.current = null; ws.current = null; sock.close(); return }
      if (m.type === 'error') return setError(m.error)
    }
  }, [])

  useEffect(() => {
    open()
    return () => { const s = ws.current; ws.current = null; s?.close() }
  }, [open])

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
    send, create, join, leave,
  }
}

/** Downscale to 128px and upload as a data URL. ~10 KB, no multipart, no bucket. */
export async function uploadAvatar(file) {
  const bitmap = await createImageBitmap(file)
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const scale = Math.max(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  const dataUrl = c.toDataURL('image/jpeg', 0.8)
  const res = await fetch('/api/avatar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  })
  if (!res.ok) throw new Error('upload failed')
  return (await res.json()).url
}
