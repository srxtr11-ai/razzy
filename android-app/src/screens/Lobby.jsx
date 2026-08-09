import { useEffect, useRef, useState } from 'react'
import { Camera, Clapperboard, LogIn, Minus, Plus, Settings2, Users } from 'lucide-react'
import { api, identity, pickAvatar, remember } from '../api.js'
import { Avatar, Button, useLayout } from '../components/ui.jsx'

export default function Lobby({ party, onFriends, friendCount = 0 }) {
  const me = identity()
  const { tablet, landscape, short } = useLayout()
  const [name, setName] = useState(me.name)
  const [avatar, setAvatar] = useState(me.avatar)
  const [code, setCode] = useState('')
  const [cap, setCap] = useState(6)
  const [busy, setBusy] = useState(false)
  const [showServer, setShowServer] = useState(false)
  const [server, setServer] = useState(api.isDefault ? '' : api.base)
  const file = useRef(null)

  const ready = name.trim().length > 0
  const save = () => remember(name.trim(), avatar)

  // Friends see this before you've joined anything, so it can't wait for the
  // first party — otherwise everyone shows up in their list as "Guest".
  useEffect(() => {
    if (!name.trim()) return
    const t = setTimeout(() => party.setProfile(name.trim(), avatar), 600)
    return () => clearTimeout(t)
  }, [name, avatar]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setBusy(true)
    try { setAvatar(await pickAvatar(f)) } catch { party.setError('Could not upload that picture') }
    setBusy(false)
  }

  return (
    <div
      className="h-full overflow-y-auto no-scrollbar"
      style={{
        paddingTop: 'calc(var(--top) + 1rem)',
        paddingBottom: 'calc(var(--bottom) + 1.5rem)',
        paddingLeft: 'calc(var(--left) + 1.25rem)',
        paddingRight: 'calc(var(--right) + 1.25rem)',
      }}
    >
      {/* A tablet has room to breathe; a phone in landscape has almost none. */}
      <div className={`mx-auto w-full ${tablet ? 'max-w-xl' : 'max-w-md'} rise`}>
        <div className={`flex flex-col items-center ${short ? 'mb-4' : 'mb-7'}`}>
          <img
            src="/logo.png"
            alt="Razzy"
            className="w-auto"
            style={{ height: short ? 44 : tablet ? 92 : 68 }}
          />
          {!short && <p className="text-white/40 text-sm mt-2">Same movie. Same second.</p>}
        </div>

        {/* Two columns once there is genuinely room, stacked otherwise. */}
        <div className={landscape && tablet ? 'grid grid-cols-2 gap-4 items-start' : 'space-y-4'}>
          <section className="glass rounded-3xl p-4">
            <div className="flex items-center gap-4">
              <button onClick={() => file.current?.click()} className="press relative rounded-full shrink-0">
                <Avatar m={{ name, avatar }} size={tablet ? 68 : 58} dim={busy} />
                <span
                  className="absolute -bottom-1 -right-1 rounded-full bg-grass text-black grid place-items-center"
                  style={{ width: 26, height: 26, boxShadow: '0 0 0 3px var(--color-ink)' }}
                >
                  <Camera size={13} strokeWidth={2.5} />
                </span>
              </button>
              <input ref={file} type="file" accept="image/*" hidden onChange={choose} />
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 24))}
                placeholder="Your name"
                className="flex-1 min-w-0 bg-white/8 rounded-2xl px-4 outline-none focus:bg-white/12"
                style={{ height: 'var(--tap)' }}
              />
            </div>
          </section>

          <section className="glass rounded-3xl p-4 space-y-3">
            <label className="block text-[11px] uppercase tracking-[0.2em] text-white/35">Join a party</label>
            <div className="flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))}
                placeholder="ABC"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                className="w-28 bg-white/8 rounded-2xl text-center font-bold tracking-[0.3em] outline-none focus:bg-white/12"
                style={{ height: 'var(--tap)', fontSize: 24 }}
              />
              <Button
                kind="primary"
                className="flex-1"
                disabled={!ready || code.length !== 3}
                onClick={() => { save(); party.join(code, name.trim(), avatar) }}
              >
                <LogIn size={17} />
                Join
              </Button>
            </div>
          </section>

          <section className={`glass rounded-3xl p-4 space-y-3 ${landscape && tablet ? 'col-span-2' : ''}`}>
            <label className="block text-[11px] uppercase tracking-[0.2em] text-white/35">Start a party</label>
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/70">Max people</span>
              <div className="flex items-center gap-3">
                <button
                  className="press rounded-full bg-white/8 grid place-items-center"
                  style={{ width: 'var(--tap)', height: 'var(--tap)' }}
                  onClick={() => setCap((c) => Math.max(2, c - 1))}
                  aria-label="Fewer"
                >
                  <Minus size={16} />
                </button>
                <span className="w-8 text-center font-semibold tabular-nums text-lg">{cap}</span>
                <button
                  className="press rounded-full bg-white/8 grid place-items-center"
                  style={{ width: 'var(--tap)', height: 'var(--tap)' }}
                  onClick={() => setCap((c) => Math.min(50, c + 1))}
                  aria-label="More"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <Button
              kind="primary"
              className="w-full"
              disabled={!ready}
              onClick={() => { save(); party.create(name.trim(), avatar, cap) }}
            >
              <Clapperboard size={18} />
              Create party
            </Button>
          </section>

          {/* Friends live outside any party, so the way in is here too. */}
          <section className={`glass rounded-3xl p-2 ${landscape && tablet ? 'col-span-2' : ''}`}>
            <Button kind="ghost" className="w-full justify-between px-4" onClick={onFriends}>
              <span className="flex items-center gap-2">
                <Users size={17} />
                Friends
              </span>
              {friendCount > 0 && (
                <span className="min-w-5 h-5 px-1 rounded-full bg-grass text-black text-[11px] font-bold grid place-items-center">
                  {friendCount}
                </span>
              )}
            </Button>
          </section>
        </div>

        <div className="mt-5 text-center space-y-2">
          {party.error && <p className="text-sm text-red-400 rise">{party.error}</p>}
          <p className="text-xs text-white/25">
            {party.connected ? 'Connected' : 'Connecting…'} · {new URL(api.base).host}
          </p>
          <button
            onClick={() => setShowServer((v) => !v)}
            className="press inline-flex items-center gap-1.5 text-[11px] text-white/25 py-2 px-3"
          >
            <Settings2 size={12} />
            Server
          </button>

          {/* Escape hatch for testing against a laptop instead of Railway. */}
          {showServer && (
            <div className="flex gap-2 pt-1 rise">
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://razzy.up.railway.app"
                autoCapitalize="off"
                autoCorrect="off"
                className="flex-1 min-w-0 bg-white/8 rounded-2xl px-3 text-xs outline-none"
                style={{ height: 44 }}
              />
              <Button
                kind="ghost"
                className="px-3 text-xs"
                style={{ minHeight: 44 }}
                onClick={() => { api.base = server.trim(); location.reload() }}
              >
                Use
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
