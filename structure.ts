// 会場構造まわりの補助：出入口の壁スナップ、縮尺変更、原点合わせ、サンプル会場
import { cleanPoly, nearestEdge, pointInPoly, ptsBBox, rad } from './geometry'
import type { Brief, EntranceKind, Obj, Project, Pt, Venue } from './types'
import { uid } from './types'

/** 出入口オブジェクトを最寄りの壁に吸着させ、ローカル上側が屋外になるよう回転を決める */
export function snapEntrance(o: Obj, venue: Venue): Obj {
  const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 }
  const e = nearestEdge(c, venue.outline)
  const a = venue.outline[e.i]
  const b = venue.outline[(e.i + 1) % venue.outline.length]
  const w = Math.min(o.w, Math.max(600, e.len - 200))
  // 開口が辺からはみ出さないように位置を寄せる
  const half = w / 2 / Math.max(1, e.len)
  const t = Math.max(half, Math.min(1 - half, e.t))
  const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  let rot = e.angle
  const r = rad(rot)
  const inside = { x: q.x - Math.sin(r) * 300, y: q.y + Math.cos(r) * 300 }
  if (!pointInPoly(inside, venue.outline)) rot += 180
  rot = ((Math.round(rot * 100) / 100) % 360 + 360) % 360
  const h = Math.max(400, venue.wallT * 2)
  return { ...o, w, h, x: q.x - w / 2, y: q.y - h / 2, rot }
}

export function makeEntrance(venue: Venue, at: Pt, width: number, kind: EntranceKind, label?: string): Obj {
  const o: Obj = { id: uid('s'), type: 'entrance', x: at.x - width / 2, y: at.y - 200, w: width, h: 400, rot: 0, label, props: { kind } }
  return snapEntrance(o, venue)
}

export function rectVenue(w: number, h: number, name = '会場'): Venue {
  return { name, wallT: 200, outline: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] }
}

function scaleObj(o: Obj, k: number): Obj {
  const n: Obj = { ...o, x: o.x * k, y: o.y * k, w: o.w * k, h: o.h * k }
  if (o.type === 'flow' && o.props?.pts) n.props = { ...o.props, pts: (o.props.pts as number[]).map((v) => v * k) }
  return n
}

/** 縮尺を k 倍する（基準寸法合わせ）。会場構造は拡縮、配置案は作り直し前提で同倍率にする */
export function rescaleProject(p: Project, k: number): Project {
  if (!isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-6) return p
  return {
    ...p,
    venue: { ...p.venue, outline: p.venue.outline.map((q) => ({ x: q.x * k, y: q.y * k })) },
    structure: p.structure.map((o) => {
      const s = scaleObj(o, k)
      // 出入口と壁の厚みは実寸のまま
      if (o.type === 'entrance') return { ...s, h: o.h, y: s.y + (s.h - o.h) / 2 }
      return s
    }),
    source: p.source ? { ...p.source, mmPerPx: p.source.mmPerPx * k, x: p.source.x * k, y: p.source.y * k } : null,
    plans: p.plans.map((pl) => ({ ...pl, objects: pl.objects.map((o) => scaleObj(o, k)) })),
  }
}

/** 会場の左上が (0,0) になるよう全体を平行移動する */
export function normalizeOrigin(p: Project): Project {
  const bb = ptsBBox(p.venue.outline)
  const dx = -bb.x
  const dy = -bb.y
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return p
  const mv = (o: Obj): Obj => {
    const n: Obj = { ...o, x: o.x + dx, y: o.y + dy }
    if (o.type === 'flow' && o.props?.pts) n.props = { ...o.props, pts: (o.props.pts as number[]).map((v, i) => (i % 2 ? v + dy : v + dx)) }
    return n
  }
  return {
    ...p,
    venue: { ...p.venue, outline: p.venue.outline.map((q) => ({ x: q.x + dx, y: q.y + dy })) },
    structure: p.structure.map(mv),
    source: p.source ? { ...p.source, x: p.source.x + dx, y: p.source.y + dy } : null,
    plans: p.plans.map((pl) => ({ ...pl, objects: pl.objects.map(mv) })),
  }
}

export function setOutline(p: Project, outline: Pt[]): Project {
  const clean = cleanPoly(outline, 50)
  const venue = { ...p.venue, outline: clean.length >= 3 ? clean : outline }
  return { ...p, venue, structure: p.structure.map((o) => (o.type === 'entrance' ? snapEntrance(o, venue) : o)) }
}

export const DEFAULT_BRIEF: Brief = {
  title: '企業カンファレンス 2026',
  eventType: 'conference',
  attendees: 300,
  stage: true,
  stageSide: 'auto',
  seatingStyle: 'auto',
  seats: 300,
  vipSeats: 0,
  reception: 3,
  booths: 5,
  boothW: 3000,
  boothD: 3000,
  aisleMin: 1200,
  screen: true,
  podium: true,
  foh: true,
  camera: false,
  staff: true,
  cloak: false,
  firstaid: false,
  lounge: false,
  food: 0,
  merch: 0,
  notes: '入口付近に受付を設置。ステージは奥側。来場者の導線と搬入経路を確保し、避難経路を塞がない。',
}

/** 設計メモの例（約600㎡・300人の企業カンファレンス）をもとにしたサンプル */
export function sampleProject(): Project {
  const venue = rectVenue(30000, 20000, 'サンプルホール（30m × 20m）')
  const col = (x: number, y: number): Obj => ({ id: uid('s'), type: 'column', x: x - 300, y: y - 300, w: 600, h: 600, rot: 0 })
  const structure: Obj[] = [
    col(7500, 15400),
    col(22500, 15400),
    makeEntrance(venue, { x: 15000, y: 20000 }, 2400, 'entrance'),
    makeEntrance(venue, { x: 0, y: 14400 }, 1800, 'exit'),
    makeEntrance(venue, { x: 30000, y: 14400 }, 1800, 'emergency'),
    makeEntrance(venue, { x: 30000, y: 3200 }, 3000, 'loading'),
  ]
  return {
    v: 1,
    name: '企業カンファレンス 2026',
    sample: true,
    source: null,
    venue,
    structure,
    brief: { ...DEFAULT_BRIEF },
    plans: [],
    activePlan: null,
  }
}

export function emptyProject(w = 30000, h = 20000): Project {
  const venue = rectVenue(w, h)
  return { v: 1, name: '新しい図面', source: null, venue, structure: [makeEntrance(venue, { x: w / 2, y: h }, 1800, 'entrance')], brief: { ...DEFAULT_BRIEF, title: '新しいイベント' }, plans: [], activePlan: null }
}
