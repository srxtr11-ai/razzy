import { Crown } from 'lucide-react'

export function Avatar({ m, size = 36, dim }) {
  const initial = (m.name || '?').trim()[0]?.toUpperCase() || '?'
  return (
    <div
      className={`relative shrink-0 rounded-full overflow-hidden grid place-items-center font-semibold
        transition-opacity duration-500 ${dim ? 'opacity-40' : ''}`}
      style={{
        width: size,
        height: size,
        background: '#1b2029',
        fontSize: size * 0.42,
        boxShadow: 'inset 0 1px 1px rgba(255,255,255,.2), 0 2px 6px rgba(0,0,0,.5)',
      }}
    >
      {m.avatar ? <img src={m.avatar} alt="" className="w-full h-full object-cover" /> : initial}
    </div>
  )
}

/** Router-style signal bars from round-trip latency. Null ping = unknown. */
export function Signal({ ping, online }) {
  const bars = !online ? 0 : ping == null ? 1 : ping < 80 ? 4 : ping < 180 ? 3 : ping < 400 ? 2 : 1
  const color = !online ? '#5b6270' : bars >= 3 ? 'var(--color-grass)' : bars === 2 ? '#eab308' : '#ef4444'
  return (
    <span className="inline-flex items-end gap-[2px] h-3" title={online ? `${ping ?? '—'} ms` : 'offline'}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-[1px] transition-all duration-500"
          style={{ height: 3 + i * 2.2, background: i <= bars ? color : '#333a45' }}
        />
      ))}
    </span>
  )
}

/**
 * Owner badge. Sits inside the avatar's own bounds — anchoring it outside got
 * clipped by the scrolling member row.
 */
export function OwnerBadge({ size = 32 }) {
  const d = Math.round(size * 0.58) // small enough to sit on the avatar, big enough to read
  return (
    <span
      className="absolute top-0 left-0 grid place-items-center rounded-full
        bg-yellow-400 text-black shadow-[0_1px_5px_rgba(0,0,0,.7)]"
      style={{ width: d, height: d }}
      title="Host"
    >
      <Crown size={Math.round(d * 0.62)} strokeWidth={2.75} fill="currentColor" />
    </span>
  )
}

/** Follows the pointer with a light cone, like the liquid bar's glare. */
export const glare = {
  onPointerMove: (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--x', `${e.clientX - r.left}px`)
    e.currentTarget.style.setProperty('--y', `${e.clientY - r.top}px`)
  },
}

export function Button({ kind = 'ghost', className = '', ...p }) {
  // inline-flex in the base: without it an icon and its label don't share a
  // baseline, and every button with both rendered with the icon adrift.
  const base = `press rounded-full px-5 h-11 text-sm font-semibold inline-flex items-center
    justify-center gap-2 whitespace-nowrap disabled:opacity-40 disabled:active:scale-100`
  const kinds = {
    primary: 'bg-grass text-black hover:bg-grass-dim shadow-[0_4px_14px_-2px_rgba(34,197,94,.5)]',
    ghost: 'text-white/85 hover:text-white hover:bg-white/10',
    danger: 'bg-red-500/90 text-white hover:bg-red-500',
  }
  return <button className={`${base} ${kinds[kind]} ${className}`} {...p} />
}

export const fmt = (s) => {
  if (!isFinite(s)) return '0:00'
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
