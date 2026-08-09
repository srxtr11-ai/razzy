import { useEffect, useRef, useState } from 'react'
import { Camera, Clapperboard, LogIn, Minus, Plus, Users } from 'lucide-react'
import { identity, remember, uploadAvatar } from './party.js'
import { Avatar, Button, glare } from './ui.jsx'
import Cropper from './Cropper.jsx'

/** Ambient colour for the glass to refract — without it, glass reads as grey. */
export function Ambient() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-ink">
      <div className="blob w-[50vw] h-[50vw] -top-[10%] -left-[10%] bg-grass" />
      <div className="blob w-[45vw] h-[45vw] -bottom-[10%] -right-[10%] bg-emerald-400" style={{ animationDelay: '-5s' }} />
      <div className="blob w-[35vw] h-[35vw] top-[30%] left-[40%] bg-teal-500" style={{ animationDelay: '-10s' }} />
    </div>
  )
}

export default function Lobby({ party, onFriends, friendCount = 0 }) {
  const me = identity()
  const [name, setName] = useState(me.name)
  const [avatar, setAvatar] = useState(me.avatar)
  const [code, setCode] = useState('')
  const [cap, setCap] = useState(6)
  const [busy, setBusy] = useState(false)
  const [cropping, setCropping] = useState(null)
  const file = useRef(null)

  const ready = name.trim().length > 0
  const save = () => remember(name.trim(), avatar)

  // Your friends see this name, and they see it before you have joined anything,
  // so it can't wait for the first party to be saved.
  useEffect(() => {
    if (!name.trim()) return
    const t = setTimeout(() => party.setProfile(name.trim(), avatar), 600)
    return () => clearTimeout(t)
  }, [name, avatar]) // eslint-disable-line react-hooks/exhaustive-deps

  // Choosing the file only opens the cropper; nothing is uploaded until it's
  // framed. A phone camera hands you a photo of a whole room.
  const pick = (e) => {
    const f = e.target.files?.[0]
    e.target.value = '' // so picking the same file twice still fires
    if (f) setCropping(f)
  }

  const saveAvatar = async (dataUrl) => {
    setBusy(true)
    try {
      const url = await uploadAvatar(dataUrl)
      setAvatar(url)
      party.setProfile(name.trim() || 'Guest', url)
      setCropping(null)
    } catch {
      party.setError('Could not upload that image')
    }
    setBusy(false)
  }

  return (
    <>
      <Ambient />
      {/* Friends live outside any party, so the way in is here too. */}
      <button
        onClick={onFriends}
        className="liquid press fixed top-4 right-4 z-40 rounded-2xl h-11 px-4 flex items-center gap-2 text-sm font-semibold"
      >
        <Users size={16} />
        Friends
        {friendCount > 0 && (
          <span className="min-w-5 h-5 px-1 rounded-full bg-grass text-black text-[11px] font-bold grid place-items-center">
            {friendCount}
          </span>
        )}
      </button>
      <div className="min-h-full grid place-items-center p-6">
        <div className="w-full max-w-sm rise">
          {/* 3.39:1 lockup — fix the height and let width follow, so it never distorts */}
          <img
            src="/logo.png"
            alt="Razzy"
            width={640}
            height={189}
            className="block mx-auto h-20 sm:h-24 w-auto mb-3 drop-shadow-[0_0_34px_rgba(216,248,112,0.28)]"
          />
          <p className="text-center text-white/40 text-sm mb-8">Same movie. Same second.</p>

          <div className="liquid glare rounded-[2rem] p-5 space-y-5" onPointerMove={glare.onPointerMove}>
            <div className="flex items-center gap-4">
              <button onClick={() => file.current?.click()} className="press relative rounded-full" aria-label="Choose profile picture">
                <Avatar m={{ name, avatar }} size={60} dim={busy} />
                <span className="absolute -bottom-0.5 -right-0.5 w-7 h-7 rounded-full bg-grass text-black grid place-items-center ring-2 ring-ink">
                  <Camera size={14} strokeWidth={2.5} />
                </span>
              </button>
              <input ref={file} type="file" accept="image/*" hidden onChange={pick} />
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 24))}
                placeholder="Your name"
                className="flex-1 bg-white/8 rounded-full px-4 h-12 outline-none focus:bg-white/12 transition min-w-0"
              />
            </div>

            <div className="h-px bg-white/10" />

            <div className="space-y-2">
              <label className="text-[11px] uppercase tracking-[0.2em] text-white/35">Join a party</label>
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))}
                  placeholder="ABC"
                  autoCapitalize="characters"
                  className="w-28 bg-white/8 rounded-2xl px-3 h-12 text-center text-2xl font-bold tracking-[0.3em] outline-none focus:bg-white/12 transition"
                />
                <Button
                  kind="primary"
                  className="flex-1 flex items-center justify-center gap-2"
                  disabled={!ready || code.length !== 3}
                  onClick={() => { save(); party.join(code, name.trim(), avatar) }}
                >
                  <LogIn size={16} />
                  Join
                </Button>
              </div>
            </div>

            <div className="h-px bg-white/10" />

            <div className="space-y-2">
              <label className="text-[11px] uppercase tracking-[0.2em] text-white/35">Start a party</label>
              <div className="flex items-center justify-between text-sm text-white/70">
                <span>Max people</span>
                <div className="flex items-center gap-3">
                  <button
                    className="press w-9 h-9 rounded-full bg-white/8 grid place-items-center hover:bg-white/15"
                    onClick={() => setCap((c) => Math.max(2, c - 1))}
                    aria-label="Fewer people"
                  >
                    <Minus size={15} />
                  </button>
                  <span className="w-6 text-center font-semibold text-white tabular-nums">{cap}</span>
                  <button
                    className="press w-9 h-9 rounded-full bg-white/8 grid place-items-center hover:bg-white/15"
                    onClick={() => setCap((c) => Math.min(50, c + 1))}
                    aria-label="More people"
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              <Button
                kind="primary"
                className="w-full flex items-center justify-center gap-2"
                disabled={!ready}
                onClick={() => { save(); party.create(name.trim(), avatar, cap) }}
              >
                <Clapperboard size={17} />
                Create party
              </Button>
            </div>
          </div>

          {party.error && <p className="mt-4 text-center text-sm text-red-400 rise">{party.error}</p>}
          {!party.connected && <p className="mt-4 text-center text-xs text-white/30">Connecting…</p>}
        </div>
      </div>

      {cropping && (
        <Cropper file={cropping} onCancel={() => setCropping(null)} onDone={saveAvatar} />
      )}
    </>
  )
}
