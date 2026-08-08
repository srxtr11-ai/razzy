import { useEffect, useState } from 'react'
import { Crown, Shield } from 'lucide-react'

/**
 * One place that decides what kind of device this is, so no component has to
 * guess. Width alone is not enough: a phone in landscape is short, not wide,
 * and a 10" tablet in portrait is wide but should still stack.
 */
export function useLayout() {
  const read = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    const min = Math.min(w, h)
    return {
      w,
      h,
      landscape: w > h,
      // ≥600dp shortest side is Android's own definition of a tablet
      tablet: min >= 600,
      // side-by-side only when there is genuinely room for both
      split: min >= 600 && w >= 840,
      short: h < 480, // phone in landscape: chrome has to get out of the way
    }
  }
  const [layout, setLayout] = useState(read)
  useEffect(() => {
    const on = () => setLayout(read())
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    return () => {
      window.removeEventListener('resize', on)
      window.removeEventListener('orientationchange', on)
    }
  }, [])
  return layout
}

/**
 * The on-screen keyboard does not resize the WebView (Capacitor is configured
 * that way on purpose, so the video never jumps). visualViewport tells us how
 * much it covers, and the composer lifts by exactly that much.
 */
export function useKeyboardInset() {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const on = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    on()
    return () => {
      vv.removeEventListener('resize', on)
      vv.removeEventListener('scroll', on)
    }
  }, [])
  return inset
}

export function Avatar({ m, size = 36, dim }) {
  const initial = (m?.name || '?').trim()[0]?.toUpperCase() || '?'
  return (
    <div
      className={`relative shrink-0 rounded-full overflow-hidden grid place-items-center font-semibold ${dim ? 'opacity-40' : ''}`}
      style={{
        width: size,
        height: size,
        background: '#1b2029',
        fontSize: size * 0.42,
        boxShadow: 'inset 0 1px 1px rgba(255,255,255,.18)',
      }}
    >
      {m?.avatar ? <img src={m.avatar} alt="" className="w-full h-full object-cover" /> : initial}
    </div>
  )
}

export function OwnerBadge({ size = 32 }) {
  const d = Math.round(size * 0.58)
  return (
    <span
      className="absolute top-0 left-0 grid place-items-center rounded-full bg-yellow-400 text-black shadow"
      style={{ width: d, height: d }}
      title="Host"
    >
      <Crown size={Math.round(d * 0.62)} strokeWidth={2.75} fill="currentColor" />
    </span>
  )
}

export function CoHostBadge({ size = 32 }) {
  const d = Math.round(size * 0.55)
  return (
    <span
      className="absolute top-0 left-0 grid place-items-center rounded-full bg-sky-400 text-black shadow"
      style={{ width: d, height: d }}
      title="Co-host"
    >
      <Shield size={Math.round(d * 0.58)} strokeWidth={2.75} fill="currentColor" />
    </span>
  )
}

export function Signal({ ping, online }) {
  const bars = !online ? 0 : ping == null ? 1 : ping < 80 ? 4 : ping < 180 ? 3 : ping < 400 ? 2 : 1
  const color = !online ? '#5b6270' : bars >= 3 ? 'var(--color-grass)' : bars === 2 ? '#eab308' : '#ef4444'
  return (
    <span className="inline-flex items-end gap-[2px] h-3">
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-[1px]"
          style={{ height: 3 + i * 2.2, background: i <= bars ? color : '#333a45' }}
        />
      ))}
    </span>
  )
}

/** Every tappable thing is at least --tap tall; Android's guidance is 48dp. */
export function Button({ kind = 'ghost', className = '', style, ...p }) {
  const kinds = {
    primary: 'bg-grass text-black font-semibold active:bg-grass-dim',
    ghost: 'glass text-white/90',
    plain: 'text-white/70',
    danger: 'bg-red-500 text-white font-semibold',
  }
  // inline-flex, not grid: a grid centres icon and label into separate rows, so
  // every button with an icon stacked into two lines.
  return (
    <button
      className={`press rounded-2xl px-4 inline-flex items-center justify-center gap-2 whitespace-nowrap
        disabled:opacity-40 ${kinds[kind]} ${className}`}
      style={{ minHeight: 'var(--tap)', ...style }}
      {...p}
    />
  )
}

export const fmt = (s) => {
  if (!isFinite(s)) return '0:00'
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
