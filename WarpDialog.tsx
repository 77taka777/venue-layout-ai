import { useRef, useState } from 'react'
import type { Pt } from '../core/types'
import { warpPerspective } from '../io/files'

interface Props {
  dataUrl: string
  w: number
  h: number
  onDone: (r: { dataUrl: string; w: number; h: number }) => void
  onClose: () => void
}

/** 写真の台形補正：図面の四隅を指定して、正面から見た形に直す */
export function WarpDialog({ dataUrl, w, h, onDone, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [quad, setQuad] = useState<Pt[]>([
    { x: w * 0.08, y: h * 0.08 },
    { x: w * 0.92, y: h * 0.08 },
    { x: w * 0.92, y: h * 0.92 },
    { x: w * 0.08, y: h * 0.92 },
  ])
  const [busy, setBusy] = useState(false)
  const drag = useRef<number | null>(null)
  const names = ['左上', '右上', '右下', '左下']

  const toImg = (e: React.PointerEvent): Pt => {
    const r = (box.current as HTMLDivElement).getBoundingClientRect()
    return { x: Math.max(0, Math.min(w, ((e.clientX - r.left) / r.width) * w)), y: Math.max(0, Math.min(h, ((e.clientY - r.top) / r.height) * h)) }
  }
  const move = (e: React.PointerEvent) => {
    if (drag.current === null) return
    const p = toImg(e)
    setQuad((q) => q.map((v, i) => (i === drag.current ? p : v)))
  }
  const run = async () => {
    setBusy(true)
    try {
      onDone(await warpPerspective(dataUrl, quad))
    } finally {
      setBusy(false)
    }
  }
  const sw = Math.max(w, h) / 320

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="台形補正">
      <div className="modal-card">
        <h2>台形補正</h2>
        <p className="hint">斜めから撮った写真は、図面の四隅に丸を合わせると正面から見た形に直せます。</p>
        <div ref={box} className="warp-box" style={{ aspectRatio: `${w} / ${h}` }} onPointerMove={move} onPointerUp={() => (drag.current = null)} onPointerLeave={() => (drag.current = null)}>
          <img src={dataUrl} alt="読み込んだ図面" draggable={false} />
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(29,95,209,0.14)" stroke="#1D5FD1" strokeWidth={sw} />
            {quad.map((p, i) => (
              <g key={i} onPointerDown={(e) => { drag.current = i; (e.target as Element).setPointerCapture?.(e.pointerId) }} style={{ cursor: 'grab', touchAction: 'none' }}>
                <circle cx={p.x} cy={p.y} r={sw * 9} fill="transparent" />
                <circle cx={p.x} cy={p.y} r={sw * 4.5} fill="#fff" stroke="#1D5FD1" strokeWidth={sw * 1.4} />
                <text x={p.x} y={p.y - sw * 7} fontSize={sw * 7} textAnchor="middle" fill="#1D5FD1" fontWeight="600" style={{ pointerEvents: 'none' }}>{names[i]}</text>
              </g>
            ))}
          </svg>
        </div>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>やめる</button>
          <button type="button" className="btn primary" onClick={run} disabled={busy}>{busy ? '補正しています…' : 'この範囲で補正する'}</button>
        </div>
      </div>
    </div>
  )
}
