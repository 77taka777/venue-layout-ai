// プロジェクトに対する編集操作（すべてイミュータブル）。UIの操作とAIチャット編集の両方がここを通る。
import { CATALOG, SEAT, cat, makeObj, objName } from './catalog'
import { clamp, norm360, objCenter, snap } from './geometry'
import { buildPlan, defaultSpecs, sanitizeSpec } from './planner'
import { seatBlockers, seatCount } from './seats'
import { snapEntrance } from './structure'
import type { Brief, Obj, ObjType, Plan, Project } from './types'
import { uid } from './types'

export type Mode = 'layout' | 'structure'

export const activePlan = (p: Project): Plan | null => p.plans.find((x) => x.id === p.activePlan) || p.plans[0] || null

export function mapPlan(p: Project, fn: (plan: Plan) => Plan): Project {
  const cur = activePlan(p)
  if (!cur) return p
  return { ...p, plans: p.plans.map((x) => (x.id === cur.id ? fn(x) : x)) }
}

export const listObjs = (p: Project, mode: Mode): Obj[] => (mode === 'structure' ? p.structure : activePlan(p)?.objects || [])

export function setObjs(p: Project, mode: Mode, fn: (list: Obj[]) => Obj[]): Project {
  if (mode === 'structure') return { ...p, sample: false, structure: fn(p.structure) }
  return mapPlan(p, (pl) => ({ ...pl, objects: fn(pl.objects) }))
}

/** 手動の配置案がなければ空の案を作る */
export function ensurePlan(p: Project): Project {
  if (activePlan(p)) return p
  const plan: Plan = { id: uid('p'), name: '手動案', concept: '手動レイアウト', rationale: [], origin: 'manual', objects: [], notes: [] }
  return { ...p, plans: [...p.plans, plan], activePlan: plan.id }
}

export function moveObj(o: Obj, dx: number, dy: number): Obj {
  const n: Obj = { ...o, x: o.x + dx, y: o.y + dy }
  if (o.type === 'flow' && o.props?.pts) n.props = { ...o.props, pts: (o.props.pts as number[]).map((v, i) => (i % 2 ? v + dy : v + dx)) }
  return n
}

/** 客席ブロックは列・行の数に合わせてサイズを決める */
export function fitSeatBlock(o: Obj, w: number, h: number): Obj {
  if (o.type !== 'seat_block') return { ...o, w, h }
  const style = (o.props?.style as keyof typeof SEAT) || 'theater'
  const d = SEAT[style] || SEAT.theater
  const cols = Math.max(1, Math.round(w / d.pitchX))
  const rows = Math.max(1, Math.round(h / d.pitchY))
  return { ...o, w: cols * d.pitchX, h: rows * d.pitchY, props: { ...o.props, rows, cols } }
}

export function setFlowPts(o: Obj, pts: number[]): Obj {
  const xs = pts.filter((_, i) => i % 2 === 0)
  const ys = pts.filter((_, i) => i % 2 === 1)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { ...o, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, props: { ...o.props, pts } }
}

export function duplicate(list: Obj[], ids: string[], dx = 600, dy = 600): { list: Obj[]; ids: string[] } {
  const made: Obj[] = []
  for (const o of list) if (ids.includes(o.id)) made.push({ ...moveObj(o, dx, dy), id: uid() })
  return { list: [...list, ...made], ids: made.map((m) => m.id) }
}

export function planSeatCount(p: Project, plan: Plan | null): number {
  if (!plan) return 0
  const env = { blockers: seatBlockers(p.structure, plan.objects), outline: p.venue.outline }
  return plan.objects.reduce((a, o) => a + (o.hidden ? 0 : seatCount(o, env)), 0)
}

// ───────────────────────── AIチャット編集 ─────────────────────────

const r1 = (mm: number) => Math.round(mm / 100) / 10

/** AIに渡す現在の状態（m単位・中心座標） */
export function chatState(p: Project, plan: Plan): string {
  const env = { blockers: seatBlockers(p.structure, plan.objects), outline: p.venue.outline }
  const objects = plan.objects
    .filter((o) => o.type !== 'zone' && o.type !== 'flow' && !o.hidden)
    .map((o) => {
      const c = objCenter(o)
      const row: Record<string, unknown> = { id: o.id, type: o.type, name: objName(o), cx: r1(c.x), cy: r1(c.y), w: r1(o.w), h: r1(o.h), rot: o.rot }
      if (o.type === 'seat_block') Object.assign(row, { style: o.props?.style, rows: o.props?.rows, cols: o.props?.cols, seats: seatCount(o, env) })
      if (o.type === 'round_table') row.seats = o.props?.seats
      if (o.type === 'booth') row.no = o.props?.no
      return row
    })
  const structure = p.structure.map((s) => {
    const c = objCenter(s)
    return { type: s.type, kind: s.props?.kind, name: objName(s), cx: r1(c.x), cy: r1(c.y), w: r1(s.w), h: r1(s.h) }
  })
  return JSON.stringify({
    unit: 'm',
    origin: '会場の左上が(0,0)、xは右向き、yは下向き（図面の下側ほどyが大きい）',
    venue_outline: p.venue.outline.map((q) => [r1(q.x), r1(q.y)]),
    structure,
    brief: { eventType: p.brief.eventType, attendees: p.brief.attendees, seats: p.brief.seats, booths: p.brief.booths, reception: p.brief.reception, aisleMin_m: r1(p.brief.aisleMin) },
    plan: { name: plan.name, concept: plan.concept },
    objects,
  })
}

const BRIEF_NUM: (keyof Brief)[] = ['attendees', 'seats', 'vipSeats', 'reception', 'booths', 'boothW', 'boothD', 'aisleMin', 'food', 'merch']
const BRIEF_BOOL: (keyof Brief)[] = ['stage', 'screen', 'podium', 'foh', 'camera', 'staff', 'cloak', 'firstaid', 'lounge']

export function patchBrief(b: Brief, patch: Record<string, unknown>): Brief {
  const out: Record<string, unknown> = { ...b }
  for (const k of BRIEF_NUM) if (typeof patch[k] === 'number' && isFinite(patch[k] as number)) out[k] = Math.max(0, Math.round(patch[k] as number))
  for (const k of BRIEF_BOOL) if (typeof patch[k] === 'boolean') out[k] = patch[k]
  if (['auto', 'theater', 'classroom', 'round', 'standing', 'none'].includes(patch.seatingStyle as string)) out.seatingStyle = patch.seatingStyle
  if (['auto', 'N', 'E', 'S', 'W'].includes(patch.stageSide as string)) out.stageSide = patch.stageSide
  if (['conference', 'exhibition', 'ceremony', 'party', 'live'].includes(patch.eventType as string)) out.eventType = patch.eventType
  return out as unknown as Brief
}

export interface ChatResult {
  project: Project
  applied: number
  skipped: string[]
}

export function applyChatOps(p: Project, ops: unknown): ChatResult {
  let project = p
  let applied = 0
  const skipped: string[] = []
  const list = Array.isArray(ops) ? ops.slice(0, 200) : []
  const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v)
  for (const raw of list) {
    const op = raw as Record<string, any>
    if (!op || typeof op !== 'object') continue
    const plan = activePlan(project)
    if (!plan) break
    const find = (id: unknown) => plan.objects.find((o) => o.id === id)
    switch (op.op) {
      case 'move': {
        const o = find(op.id)
        if (!o || !isNum(op.dx) || !isNum(op.dy)) { skipped.push(`move ${op.id}`); break }
        project = setObjs(project, 'layout', (l) => l.map((x) => (x.id === o.id ? moveObj(x, op.dx * 1000, op.dy * 1000) : x)))
        applied++
        break
      }
      case 'update': {
        const o = find(op.id)
        if (!o) { skipped.push(`update ${op.id}`); break }
        let n: Obj = { ...o, props: { ...o.props } }
        if (o.type === 'seat_block') {
          if (['theater', 'classroom', 'vip'].includes(op.style)) n.props!.style = op.style
          const style = (n.props!.style as keyof typeof SEAT) || 'theater'
          const d = SEAT[style] || SEAT.theater
          let rows = isNum(op.rows) ? clamp(Math.round(op.rows), 1, 80) : Math.max(1, Math.round((isNum(op.h) ? op.h * 1000 : o.h) / d.pitchY))
          let cols = isNum(op.cols) ? clamp(Math.round(op.cols), 1, 80) : Math.max(1, Math.round((isNum(op.w) ? op.w * 1000 : o.w) / d.pitchX))
          if (op.style && op.style !== o.props?.style && !isNum(op.rows) && !isNum(op.cols)) {
            // 形式だけ変えるときは、いまの占有面積をなるべく保つ
            rows = Math.max(1, Math.round(o.h / d.pitchY))
            cols = Math.max(1, Math.round(o.w / d.pitchX))
          }
          n.props!.rows = rows
          n.props!.cols = cols
          n.w = cols * d.pitchX
          n.h = rows * d.pitchY
        } else {
          if (isNum(op.w)) n.w = clamp(op.w * 1000, 50, 200000)
          if (isNum(op.h)) n.h = clamp(op.h * 1000, 50, 200000)
          if (isNum(op.scale)) { n.w = o.w * clamp(op.scale, 0.1, 10); n.h = o.h * clamp(op.scale, 0.1, 10) }
          if (o.type === 'round_table' && isNum(op.seats)) n.props!.seats = clamp(Math.round(op.seats), 2, 14)
        }
        const c = objCenter(o)
        const cx = isNum(op.cx) ? op.cx * 1000 : c.x
        const cy = isNum(op.cy) ? op.cy * 1000 : c.y
        n.x = cx - n.w / 2
        n.y = cy - n.h / 2
        if (isNum(op.rot)) n.rot = norm360(op.rot)
        if (typeof op.label === 'string') n.label = op.label.slice(0, 30)
        if (typeof op.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(op.color)) n.color = op.color
        if (o.type === 'flow') n = moveObj(o, cx - c.x, cy - c.y)
        project = setObjs(project, 'layout', (l) => l.map((x) => (x.id === o.id ? n : x)))
        applied++
        break
      }
      case 'add': {
        const type = op.type as ObjType
        const c = CATALOG[type]
        if (!c || c.layer === 'structure' || !isNum(op.cx) || !isNum(op.cy)) { skipped.push(`add ${op.type}`); break }
        const patch: Partial<Obj> = { rot: isNum(op.rot) ? norm360(op.rot) : 0 }
        if (isNum(op.w)) patch.w = clamp(op.w * 1000, 50, 200000)
        if (isNum(op.h)) patch.h = clamp(op.h * 1000, 50, 200000)
        if (typeof op.label === 'string') patch.label = op.label.slice(0, 30)
        const props: Record<string, any> = {}
        if (type === 'seat_block') {
          props.style = ['theater', 'classroom', 'vip'].includes(op.style) ? op.style : 'theater'
          props.rows = isNum(op.rows) ? clamp(Math.round(op.rows), 1, 80) : 5
          props.cols = isNum(op.cols) ? clamp(Math.round(op.cols), 1, 80) : 10
        }
        if (type === 'booth') props.no = plan.objects.filter((o) => o.type === 'booth').reduce((a, o) => Math.max(a, Number(o.props?.no) || 0), 0) + 1
        patch.props = props
        const o = makeObj(type, op.cx * 1000, op.cy * 1000, patch)
        project = setObjs(project, 'layout', (l) => [...l, o])
        applied++
        break
      }
      case 'remove': {
        const o = find(op.id)
        if (!o) { skipped.push(`remove ${op.id}`); break }
        project = setObjs(project, 'layout', (l) => l.filter((x) => x.id !== o.id))
        applied++
        break
      }
      case 'replan': {
        const brief = patchBrief(project.brief, (op.brief as Record<string, unknown>) || {})
        const idx = Math.max(0, 'ABC'.indexOf(plan.spec?.key || 'A'))
        const base = plan.spec || defaultSpecs(brief)[idx]
        const fresh = defaultSpecs(brief)[idx]
        const sp = (op.spec as Record<string, any>) || {}
        const merged = {
          ...base,
          // 条件が変わった項目は新しい条件を優先
          stage: { ...base.stage, on: brief.stage, ...(sp.stage || {}) },
          seating: { ...base.seating, count: fresh.seating.count, style: brief.seatingStyle === 'auto' ? base.seating.style : fresh.seating.style, ...(sp.seating || {}) },
          booths: { ...base.booths, count: brief.booths, w: brief.boothW, d: brief.boothD, ...(sp.booths || {}) },
          side: { ...base.side, ...(sp.side || {}) },
          reception: typeof sp.reception === 'number' ? sp.reception : brief.reception,
          vip: typeof sp.vip === 'number' ? sp.vip : brief.vipSeats,
          stageSide: sp.stageSide || base.stageSide,
          extras: Array.isArray(sp.extras) ? sp.extras : base.extras,
        }
        const spec = sanitizeSpec(merged, brief, idx)
        spec.name = plan.concept
        spec.concept = base.concept
        spec.key = base.key
        const next = { ...project, brief }
        const built = buildPlan(next, spec, plan.origin === 'manual' ? 'rule' : plan.origin)
        project = { ...next, plans: next.plans.map((x) => (x.id === plan.id ? { ...built, id: plan.id, name: plan.name, concept: plan.concept, rationale: plan.rationale } : x)) }
        applied++
        break
      }
      default:
        skipped.push(String(op.op))
    }
  }
  return { project, applied, skipped }
}

/** 構造モードでのドラッグ終了時などに、種類ごとの後処理をかける */
export function settle(o: Obj, p: Project, grid: number): Obj {
  if (o.type === 'entrance') return snapEntrance(o, p.venue)
  if (o.type === 'flow') return o
  const r = norm360(o.rot)
  if (grid > 0 && r % 90 === 0) {
    const swap = r % 180 !== 0
    const ew = swap ? o.h : o.w
    const eh = swap ? o.w : o.h
    const cx = o.x + o.w / 2
    const cy = o.y + o.h / 2
    const ax = snap(cx - ew / 2, grid)
    const ay = snap(cy - eh / 2, grid)
    return { ...o, x: ax + ew / 2 - o.w / 2, y: ay + eh / 2 - o.h / 2 }
  }
  return o
}

export const catOf = cat
