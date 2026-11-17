import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="sec">
      <div className="sec-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      <div className="field-ctl">{children}</div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  )
}

interface NumProps {
  id: string
  value: number
  onChange: (v: number) => void
  /** 表示単位への換算（mm→m なら 1000） */
  scale?: number
  step?: number
  min?: number
  max?: number
  unit?: string
  digits?: number
}

/** 入力中は文字列で持ち、確定（フォーカスを外す・Enter）で反映する数値入力 */
export function Num({ id, value, onChange, scale = 1, step = 1, min, max, unit, digits }: NumProps) {
  const d = digits ?? (scale >= 1000 ? 1 : 0)
  const fmt = (v: number) => {
    const s = (v / scale).toFixed(d)
    return d ? s.replace(/\.?0+$/, '') || '0' : s
  }
  const [text, setText] = useState(fmt(value))
  useEffect(() => setText(fmt(value)), [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (raw: string) => {
    const n = parseFloat(raw.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
    if (!isFinite(n)) return setText(fmt(value))
    let v = n * scale
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    setText(fmt(v))
    if (Math.abs(v - value) > 1e-6) onChange(v)
  }
  return (
    <span className="num">
      <input
        id={id}
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            commit(String(value / scale + (e.key === 'ArrowUp' ? 1 : -1) * (step / scale)))
          }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </span>
  )
}

export function Toggle({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; name: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className={o.id === value ? 'on' : ''} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.name}
        </button>
      ))}
    </div>
  )
}
