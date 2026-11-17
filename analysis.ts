// AIの図面読み取り結果（画像上の 0–1000 正規化座標）を、mm単位の会場データに変換する。
// AIの出力は「候補」。ここで直角補正・壁スナップなどの幾何処理をかけ、人が確認・修正する前提にする。
import { cleanPoly, orthogonalize, polyArea, ptsBBox, snap } from './geometry'
import { makeEntrance, normalizeOrigin } from './structure'
import type { EntranceKind, Obj, Project, Pt } from './types'
import { uid } from './types'

export interface AnalysisRaw {
  venue_name?: string
  outline?: [number, number][]
  columns?: { x: number; y: number; w: number; h: number }[]
  openings?: { kind?: string; x1: number; y1: number; x2: number; y2: number; label?: string }[]
  fixed?: { label?: string; x: number; y: number; w: number; h: number }[]
  scale?: { x1: number; y1: number; x2: number; y2: number; length_mm: number; evidence?: string } | null
  estimated_width_m?: number
  notes?: string[]
  confidence?: Record<string, number>
}

const num = (v: unknown): v is number => typeof v === 'number' && isFinite(v)
const KINDS: EntranceKind[] = ['entrance', 'exit', 'emergency', 'loading']

export function applyAnalysis(project: Project, raw: AnalysisRaw): Project {
  const src = project.source
  if (!src) return project
  const notes: string[] = Array.isArray(raw.notes) ? raw.notes.filter((n) => typeof n === 'string').slice(0, 12) : []

  // 縮尺：寸法の記載が読めたらそれを採用、なければ推定幅
  let mmPerPx = src.mmPerPx
  let scaleKnown = false
  const px = (nx: number, ny: number) => ({ x: (nx / 1000) * src.wPx, y: (ny / 1000) * src.hPx })
  const sc = raw.scale
  if (sc && num(sc.length_mm) && sc.length_mm > 500 && num(sc.x1) && num(sc.y1) && num(sc.x2) && num(sc.y2)) {
    const a = px(sc.x1, sc.y1)
    const b = px(sc.x2, sc.y2)
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    if (d > 8) {
      mmPerPx = sc.length_mm / d
      scaleKnown = true
      notes.unshift(`縮尺は図面の寸法記載（${sc.evidence || `${Math.round(sc.length_mm)}mm`}）から設定しました。念のため基準寸法で確認してください`)
    }
  }
  const out = Array.isArray(raw.outline) ? raw.outline.filter((p) => Array.isArray(p) && num(p[0]) && num(p[1])) : []
  if (!scaleKnown && num(raw.estimated_width_m) && raw.estimated_width_m > 2 && out.length >= 3) {
    const xs = out.map((p) => (p[0] / 1000) * src.wPx)
    const wpx = Math.max(...xs) - Math.min(...xs)
    if (wpx > 8) mmPerPx = (raw.estimated_width_m * 1000) / wpx
    notes.unshift(`縮尺は未確定です（会場幅 約${raw.estimated_width_m}m と推定）。基準寸法を入れて確定してください`)
  } else if (!scaleKnown) notes.unshift('縮尺は未確定です。基準寸法を入れて確定してください')

  const mm = (nx: number, ny: number): Pt => {
    const p = px(nx, ny)
    return { x: p.x * mmPerPx, y: p.y * mmPerPx }
  }

  let outline: Pt[] = project.venue.outline
  if (out.length >= 3) {
    const pts = cleanPoly(orthogonalize(out.map((p) => mm(p[0], p[1]))), 150).map((p) => ({ x: snap(p.x, 50), y: snap(p.y, 50) }))
    if (pts.length >= 3 && polyArea(pts) > 4e6) outline = pts
    else notes.push('会場の輪郭をうまく読み取れませんでした。「会場を編集」で頂点を合わせてください')
  } else notes.push('会場の輪郭を読み取れませんでした。「会場を編集」で頂点を合わせてください')

  const venue = { ...project.venue, name: typeof raw.venue_name === 'string' && raw.venue_name.trim() ? raw.venue_name.trim().slice(0, 40) : project.venue.name, outline }
  const structure: Obj[] = []
  const bb = ptsBBox(outline)
  const rect = (r: { x: number; y: number; w: number; h: number }) => {
    const a = mm(r.x, r.y)
    const b = mm(r.x + r.w, r.y + r.h)
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
  }
  for (const c of (raw.columns || []).slice(0, 80)) {
    if (!num(c.x) || !num(c.y) || !num(c.w) || !num(c.h)) continue
    const r = rect(c)
    const w = Math.max(200, snap(r.w, 50))
    const h = Math.max(200, snap(r.h, 50))
    if (w > bb.w * 0.2 || h > bb.h * 0.2) continue
    structure.push({ id: uid('s'), type: 'column', x: snap(r.x + r.w / 2 - w / 2, 50), y: snap(r.y + r.h / 2 - h / 2, 50), w, h, rot: 0 })
  }
  for (const f of (raw.fixed || []).slice(0, 30)) {
    if (!num(f.x) || !num(f.y) || !num(f.w) || !num(f.h)) continue
    const r = rect(f)
    if (r.w < 300 || r.h < 300) continue
    structure.push({ id: uid('s'), type: 'fixed', x: snap(r.x, 50), y: snap(r.y, 50), w: snap(r.w, 50), h: snap(r.h, 50), rot: 0, label: typeof f.label === 'string' ? f.label.slice(0, 16) : undefined })
  }
  for (const o of (raw.openings || []).slice(0, 30)) {
    if (!num(o.x1) || !num(o.y1) || !num(o.x2) || !num(o.y2)) continue
    const a = mm(o.x1, o.y1)
    const b = mm(o.x2, o.y2)
    const width = Math.max(800, Math.min(12000, snap(Math.hypot(b.x - a.x, b.y - a.y), 100)))
    const kind = (KINDS.includes(o.kind as EntranceKind) ? o.kind : 'entrance') as EntranceKind
    structure.push(makeEntrance(venue, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, width, kind, typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 12) : undefined))
  }
  if (!structure.some((s) => s.type === 'entrance')) notes.push('出入口が見つかりませんでした。「会場を編集」で入口・非常口を追加してください')

  const next: Project = {
    ...project,
    sample: false,
    venue,
    structure,
    source: { ...src, mmPerPx, x: 0, y: 0, scaleKnown },
    plans: [],
    activePlan: null,
    analysis: { at: new Date().toISOString(), notes, confidence: raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {}, venueName: venue.name },
  }
  return normalizeOrigin(next)
}
