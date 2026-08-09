import { useEffect, useRef, useState } from 'react'
import { Check, RotateCcw, X, ZoomIn } from 'lucide-react'
import { Button } from './ui.jsx'

/**
 * Pick a picture, then drag and pinch it into the circle — the thing every app
 * does, because a phone camera produces a 4:3 photo of a whole room and a
 * profile picture is a small circle of a face.
 *
 * Before this the image was centre-cropped to a square and that was that, so
 * anyone off-centre in their own photo ended up as an ear.
 *
 * Output is a 256px square JPEG. The circle is a mask drawn on top; the file
 * itself stays square, which is what every avatar in the app expects.
 */
const OUT = 256

export default function Cropper({ file, onCancel, onDone }) {
  const box = useRef(null)
  const view = useRef(null)
  const [img, setImg] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [busy, setBusy] = useState(false)
  const drag = useRef(null)
  const pinch = useRef(null)

  useEffect(() => {
    let url
    let dead = false
    createImageBitmap(file)
      .then((bmp) => { if (!dead) setImg(bmp) })
      .catch(() => {
        // Some formats defeat createImageBitmap; an <img> is the fallback.
        url = URL.createObjectURL(file)
        const el = new Image()
        el.onload = () => { if (!dead) setImg(el) }
        el.src = url
      })
    return () => { dead = true; if (url) URL.revokeObjectURL(url) }
  }, [file])

  // The circle's diameter on screen, so drag distances map 1:1 to the preview.
  const size = () => Math.min(box.current?.clientWidth || 280, 280)

  /** Never let the picture pull away from the circle and leave a gap. */
  const clamp = (next, z = zoom) => {
    if (!img) return next
    const d = size()
    const scale = (d / Math.min(img.width, img.height)) * z
    const w = img.width * scale
    const h = img.height * scale
    const maxX = Math.max(0, (w - d) / 2)
    const maxY = Math.max(0, (h - d) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    }
  }

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX - pos.x, y: e.clientY - pos.y }
  }
  const onPointerMove = (e) => {
    if (!drag.current || drag.current.id !== e.pointerId) return
    setPos(clamp({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }))
  }
  const onPointerUp = () => { drag.current = null }

  // Pinch, for the phone. Two fingers, distance between them drives the zoom.
  const onTouchMove = (e) => {
    if (e.touches.length !== 2) return
    const [a, b] = e.touches
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (pinch.current == null) { pinch.current = { dist, zoom } ; return }
    const next = Math.min(4, Math.max(1, pinch.current.zoom * (dist / pinch.current.dist)))
    setZoom(next)
    setPos((p) => clamp(p, next))
  }
  const onTouchEnd = () => { pinch.current = null }

  // The live preview. Same maths as the export, at screen size.
  useEffect(() => {
    const cv = view.current
    if (!cv || !img) return
    const d = size()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = d * dpr
    cv.height = d * dpr
    const ctx = cv.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, d, d)
    const s = (d / Math.min(img.width, img.height)) * zoom
    const w = img.width * s
    const h = img.height * s
    ctx.drawImage(img, d / 2 - w / 2 + pos.x, d / 2 - h / 2 + pos.y, w, h)
  }, [img, zoom, pos])

  const cut = async () => {
    if (!img) return
    setBusy(true)
    const d = size()
    const scale = (d / Math.min(img.width, img.height)) * zoom
    const c = document.createElement('canvas')
    c.width = c.height = OUT
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    // Same geometry as the preview, scaled up from the on-screen circle to 256.
    const k = OUT / d
    const w = img.width * scale * k
    const h = img.height * scale * k
    ctx.drawImage(img, OUT / 2 - w / 2 + pos.x * k, OUT / 2 - h / 2 + pos.y * k, w, h)
    try {
      await onDone(c.toDataURL('image/jpeg', 0.85))
    } finally {
      setBusy(false)
    }
  }

  const d = size()

  // A solid scrim, not a blurred one: blurring a whole screen is the most
  // expensive thing a phone GPU can be asked to do here, and behind an opaque
  // card there is nothing to see through it anyway.
  return (
    <div className="fixed inset-0 z-[95] grid place-items-center px-6" style={{ background: 'rgba(4,5,7,.88)' }}>
      <div
        className="liquid rounded-[2rem] p-5 w-full max-w-sm space-y-4 card-in"
        style={{ background: '#12151a' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.2em] text-white/35 flex-1">Your picture</span>
          <button onClick={onCancel} className="press grid place-items-center w-10 h-10 rounded-xl bg-white/6" aria-label="Cancel">
            <X size={17} />
          </button>
        </div>

        {/* The circle. Everything outside it is dimmed rather than hidden, so you
            can see what you're cutting off. */}
        <div
          ref={box}
          className="relative mx-auto overflow-hidden touch-none select-none"
          style={{ width: d, height: d, borderRadius: '50%', background: '#12151a', cursor: 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <canvas ref={view} className="absolute inset-0 w-full h-full pointer-events-none" />
          <div className="absolute inset-0 rounded-full pointer-events-none" style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.25)' }} />
        </div>

        <div className="flex items-center gap-3">
          <ZoomIn size={15} className="text-white/40 shrink-0" />
          <input
            type="range" min={1} max={4} step={0.01} value={zoom}
            onChange={(e) => {
              const z = Number(e.target.value)
              setZoom(z)
              setPos((p) => clamp(p, z))
            }}
            className="flex-1"
            style={{ accentColor: 'var(--color-grass)' }}
            aria-label="Zoom"
          />
          <button
            onClick={() => { setZoom(1); setPos({ x: 0, y: 0 }) }}
            className="press grid place-items-center w-10 h-10 rounded-xl bg-white/6 shrink-0"
            aria-label="Reset"
          >
            <RotateCcw size={15} />
          </button>
        </div>

        <p className="text-[11px] text-white/30 text-center">Drag to move, pinch or slide to zoom.</p>

        <div className="flex gap-3">
          <Button kind="ghost" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button kind="primary" className="flex-1" disabled={!img || busy} onClick={cut}>
            <Check size={16} strokeWidth={3} />
            {busy ? 'Saving…' : 'Use it'}
          </Button>
        </div>
      </div>
    </div>
  )
}
