// 配置エンジン。LayoutSpec（方針）を受け取り、mm単位の正確な配置を計算する。
// 「AIは方針を考える／プログラムが正確に置く」を担う部分。
import { CATALOG, SEAT, isSolid } from './catalog'
import {
  G_BLOCK, G_INSIDE, autoCell, clamp, isAxisRect, largestRect, makeGrid, norm360, objAABB, objCenter, objGap,
  objInsidePoly, ptsBBox, rad, rasterObj, rasterPoly, rectsOverlap, snap, snapDown,
} from './geometry'
import { buildRouteMap, flowObj, route } from './route'
import { seatBlockers, seatCount } from './seats'
import type { SeatEnv } from './seats'
import type { Brief, EntranceKind, ExtraReq, FlowKind, LayoutSpec, Obj, ObjType, Plan, Project, Pt, Rect, Side } from './types'
import { uid } from './types'

const M = 500 // 壁からの離れ

interface Frame {
  R: Rect
  theta: number
  cw: number
  ch: number
}
const SIDE_THETA: Record<Side, number> = { N: 0, E: 90, S: 180, W: 270 }
const OPP: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' }

function toWorld(f: Frame, u: number, v: number): Pt {
  const du = u - f.cw / 2
  const dv = v - f.ch / 2
  const cx = f.R.x + f.R.w / 2
  const cy = f.R.y + f.R.h / 2
  switch (f.theta) {
    case 90: return { x: cx - dv, y: cy + du }
    case 180: return { x: cx - du, y: cy - dv }
    case 270: return { x: cx + dv, y: cy - du }
    default: return { x: cx + du, y: cy + dv }
  }
}
function toCanon(f: Frame, x: number, y: number): { u: number; v: number } {
  const dx = x - (f.R.x + f.R.w / 2)
  const dy = y - (f.R.y + f.R.h / 2)
  let du = dx
  let dv = dy
  if (f.theta === 90) { du = dy; dv = -dx }
  else if (f.theta === 180) { du = -dx; dv = -dy }
  else if (f.theta === 270) { du = -dy; dv = dx }
  return { u: du + f.cw / 2, v: dv + f.ch / 2 }
}

type CSide = 'top' | 'bottom' | 'left' | 'right'
interface Ent {
  o: Obj
  kind: EntranceKind
  c: Pt
  /** 室内向きの単位ベクトル */
  n: Pt
  width: number
  u: number
  v: number
  side: CSide
}

interface Ctx {
  project: Project
  outline: Pt[]
  f: Frame
  solids: Obj[]
  clears: Obj[]
  areas: Obj[]
  placed: Obj[]
  notes: string[]
  boothNo: number
}

export interface VenueInfo {
  R: Rect
  bbox: Rect
  entrances: { o: Obj; kind: EntranceKind; c: Pt; n: Pt; side: Side }[]
  mainSide: Side | null
}

/** 配置のベースになる最大の長方形領域を求める */
export function mainRect(project: Project): Rect {
  const outline = project.venue.outline
  const bbox = ptsBBox(outline)
  const blocks = project.structure.filter((s) => (s.type === 'fixed' || s.type === 'nogo' || s.type === 'wall') && !s.hidden)
  const ar = isAxisRect(outline)
  if (ar && !blocks.length) return ar
  const cell = autoCell(bbox)
  const g = makeGrid(bbox, cell)
  rasterPoly(g, outline, G_INSIDE)
  for (const b of blocks) rasterObj(g, b, G_BLOCK, cell * 0.6)
  const r = largestRect(g, (v) => (v & G_INSIDE) !== 0 && (v & G_BLOCK) === 0)
  if (!r) return bbox
  const inset = ar ? 0 : cell / 2
  return { x: r.x + inset, y: r.y + inset, w: Math.max(1000, r.w - inset * 2), h: Math.max(1000, r.h - inset * 2) }
}

/** メインの長方形の外に残る、次に大きい長方形（20㎡以上あれば） */
function secondRect(project: Project, R: Rect): Rect | null {
  const outline = project.venue.outline
  if (isAxisRect(outline)) return null
  const bbox = ptsBBox(outline)
  const cell = autoCell(bbox)
  const g = makeGrid(bbox, cell)
  rasterPoly(g, outline, G_INSIDE)
  for (const b of project.structure) if ((b.type === 'fixed' || b.type === 'nogo' || b.type === 'wall') && !b.hidden) rasterObj(g, b, G_BLOCK, cell * 0.6)
  rasterObj(g, { ...R, rot: 0 } as Obj, G_BLOCK, cell)
  const r = largestRect(g, (v) => (v & G_INSIDE) !== 0 && (v & G_BLOCK) === 0)
  if (!r || r.w * r.h < 20e6 || Math.min(r.w, r.h) < 3000) return null
  return { x: r.x + cell / 2, y: r.y + cell / 2, w: r.w - cell, h: r.h - cell }
}

function entranceNormal(o: Obj): Pt {
  const r = rad(o.rot || 0)
  return { x: -Math.sin(r), y: Math.cos(r) }
}

function sideOf(R: Rect, p: Pt): Side {
  const d: [Side, number][] = [
    ['N', Math.max(0, p.y - R.y)],
    ['S', Math.max(0, R.y + R.h - p.y)],
    ['W', Math.max(0, p.x - R.x)],
    ['E', Math.max(0, R.x + R.w - p.x)],
  ]
  d.sort((a, b) => a[1] - b[1])
  return d[0][0]
}

export function venueInfo(project: Project): VenueInfo {
  const R = mainRect(project)
  const entrances = project.structure
    .filter((s) => s.type === 'entrance' && !s.hidden)
    .map((o) => {
      const c = objCenter(o)
      return { o, kind: ((o.props?.kind as EntranceKind) || 'entrance') as EntranceKind, c, n: entranceNormal(o), side: sideOf(R, c) }
    })
  const main = pickMain(entrances)
  return { R, bbox: ptsBBox(project.venue.outline), entrances, mainSide: main ? main.side : null }
}

function pickMain<T extends { kind: EntranceKind; o: Obj }>(list: T[]): T | null {
  const ent = list.filter((e) => e.kind === 'entrance').sort((a, b) => b.o.w - a.o.w)
  if (ent.length) return ent[0]
  const other = list.filter((e) => e.kind !== 'loading').sort((a, b) => b.o.w - a.o.w)
  return other[0] || null
}

function chooseStageSide(pref: LayoutSpec['stageSide'], R: Rect, es: Side | null, ep: Pt | null): Side {
  if (pref === 'N' || pref === 'E' || pref === 'S' || pref === 'W') return pref
  const longSides: Side[] = R.w >= R.h ? ['N', 'S'] : ['E', 'W']
  const shortSides: Side[] = R.w >= R.h ? ['E', 'W'] : ['N', 'S']
  const opposite: Side = es ? OPP[es] : shortSides[0]
  if (pref === 'opposite') return opposite
  const pool = longSides.includes(opposite) ? shortSides : longSides
  const cands = pool.filter((s) => s !== es)
  if (!ep || cands.length <= 1) return cands[0] || pool[0]
  const mid = (s: Side): Pt =>
    s === 'N' ? { x: R.x + R.w / 2, y: R.y } : s === 'S' ? { x: R.x + R.w / 2, y: R.y + R.h } : s === 'W' ? { x: R.x, y: R.y + R.h / 2 } : { x: R.x + R.w, y: R.y + R.h / 2 }
  const d = (s: Side) => Math.hypot(mid(s).x - ep.x, mid(s).y - ep.y)
  return cands.sort((a, b) => d(b) - d(a))[0]
}

// ───────────────────────── 配置の基本操作 ─────────────────────────

function W(ctx: Ctx, type: ObjType, uc: number, vc: number, w: number, h: number, rot = 0, patch: Partial<Obj> = {}): Obj {
  const c = toWorld(ctx.f, uc, vc)
  return {
    id: uid(),
    type,
    x: Math.round(c.x - w / 2),
    y: Math.round(c.y - h / 2),
    w: Math.round(w),
    h: Math.round(h),
    rot: norm360(rot + ctx.f.theta),
    ...patch,
    props: { ...(CATALOG[type].props || {}), ...(patch.props || {}) },
  }
}

interface OkOpt {
  self?: ObjType
  /** 同じ種類どうしに必要な最小の隙間（指定がなければ「密着」か「通路幅以上」） */
  selfGap?: number
  noColumns?: boolean
  noAreas?: boolean
  noClears?: boolean
}

function ok(ctx: Ctx, o: Obj, gap = 0, opt: OkOpt = {}): boolean {
  if (!objInsidePoly(o, ctx.outline, 40)) return false
  const bb = objAABB(o, gap + 10)
  for (const s of ctx.solids) {
    if (opt.noColumns && s.type === 'column') continue
    if (!rectsOverlap(bb, objAABB(s))) continue
    const structural = CATALOG[s.type].layer === 'structure'
    const g = objGap(o, s)
    if (opt.self && s.type === opt.self) {
      // 同じ種類は「ぴったり並べる」か「通路幅ぶん離す」かのどちらか
      if (opt.selfGap !== undefined) {
        if (g < opt.selfGap - 1) return false
      } else if (g < -1 || (g > 60 && g < gap - 1)) return false
      continue
    }
    const need = structural ? Math.min(gap, 120) : gap
    if (g < need - 1) return false
  }
  if (!opt.noClears) for (const c of ctx.clears) if (rectsOverlap(bb, objAABB(c)) && objGap(o, c) < -1) return false
  if (!opt.noAreas) for (const a of ctx.areas) if (rectsOverlap(bb, objAABB(a)) && objGap(o, a) < -1) return false
  return true
}

function put(ctx: Ctx, o: Obj): Obj {
  ctx.placed.push(o)
  if (isSolid(o)) ctx.solids.push(o)
  else if (o.type === 'lounge' || o.type === 'standing') ctx.areas.push(o)
  return o
}

/** アンカーに最も近い、置ける位置を探して配置する */
function near(ctx: Ctx, type: ObjType, w: number, h: number, rot: number, au: number, av: number, zone: Rect, gap = 300, patch: Partial<Obj> = {}, opt: OkOpt = {}): Obj | null {
  const horiz = norm360(rot) % 180 === 0
  const eu = horiz ? w : h
  const ev = horiz ? h : w
  const x0 = zone.x + eu / 2
  const x1 = zone.x + zone.w - eu / 2
  const y0 = zone.y + ev / 2
  const y1 = zone.y + zone.h - ev / 2
  if (x1 < x0 - 1 || y1 < y0 - 1) return null
  const step = Math.max(250, Math.round(Math.max(zone.w, zone.h) / 70 / 50) * 50)
  const cands: [number, number, number][] = [[clamp(au, x0, x1), clamp(av, y0, y1), -1]]
  for (let cu = x0; cu <= x1 + 1; cu += step) for (let cv = y0; cv <= y1 + 1; cv += step) cands.push([cu, cv, (cu - au) ** 2 + (cv - av) ** 2])
  cands.sort((a, b) => a[2] - b[2])
  for (const [cu, cv] of cands) {
    const o = W(ctx, type, cu, cv, w, h, rot, patch)
    if (ok(ctx, o, gap, opt)) return put(ctx, o)
  }
  return null
}

const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, w: Math.max(0, r.w - d * 2), h: Math.max(0, r.h - d * 2) })

// ───────────────────────── 客席 ─────────────────────────

interface RowConf {
  style: 'theater' | 'classroom' | 'vip'
  px: number
  py: number
  maxPer: number
  perCol: number
  centerAisle: boolean
  A: number
  MA: number
  /** 横に並べたい席数の目安（省略時は席数から算出） */
  dc?: number
}
interface SeatRect extends Rect {
  rows: number
  cols: number
}
interface RowFill {
  rects: SeatRect[]
  aisles: number[]
  bottom: number
  seats: number
}

function fillRows(z: Rect, count: number, o: RowConf): RowFill {
  const empty: RowFill = { rects: [], aisles: [], bottom: z.y, seats: 0 }
  if (count <= 0 || z.w < o.px || z.h < o.py) return empty
  const dc = o.dc || clamp(Math.ceil(Math.sqrt((count / o.perCol) * (o.style === 'classroom' ? 1.3 : 1.9))), 1, 300)
  const aisleSum = (b: number) => (b <= 1 ? 0 : (b - 1) * o.A + (o.centerAisle && b % 2 === 0 ? o.MA - o.A : 0))
  let best: { b: number; per: number; rows: number; score: number } | null = null
  const stepB = o.centerAisle ? 2 : 1
  for (let b = o.centerAisle ? 2 : 1; b <= 12; b += stepB) {
    const mc = Math.min(o.maxPer * b, Math.floor((z.w - aisleSum(b)) / o.px))
    const perMax = Math.floor(mc / b)
    if (perMax < 1) continue
    let per = clamp(Math.ceil(dc / b), 1, perMax)
    const maxRowsFor = (rows: number) => Math.floor((z.h - (rows > 18 ? o.A : 0)) / o.py)
    let rows = Math.ceil(count / (per * b * o.perCol))
    while (rows > maxRowsFor(rows) && per < perMax) {
      per++
      rows = Math.ceil(count / (per * b * o.perCol))
    }
    rows = Math.min(rows, Math.max(0, maxRowsFor(rows)))
    if (rows < 1) continue
    const seats = rows * per * b * o.perCol
    const score = Math.max(0, count - seats) * 1000 + Math.abs(per * b - dc) * 6 + b * 4 + Math.max(0, seats - count) * 0.5
    if (!best || score < best.score) best = { b, per, rows, score }
  }
  if (!best) return o.centerAisle ? fillRows(z, count, { ...o, centerAisle: false }) : empty
  const { b, per, rows } = best
  const totalW = b * per * o.px + aisleSum(b)
  let u = z.x + (z.w - totalW) / 2
  const split = rows > 18
  const r1 = split ? Math.ceil(rows / 2) : rows
  const r2 = rows - r1
  const rects: SeatRect[] = []
  const aisles: number[] = [u - o.A / 2]
  for (let k = 0; k < b; k++) {
    const bw = per * o.px
    rects.push({ x: u, y: z.y, w: bw, h: r1 * o.py, rows: r1, cols: per })
    if (r2 > 0) rects.push({ x: u, y: z.y + r1 * o.py + o.A, w: bw, h: r2 * o.py, rows: r2, cols: per })
    u += bw
    if (k < b - 1) {
      const gap = o.centerAisle && b % 2 === 0 && k === b / 2 - 1 ? o.MA : o.A
      aisles.push(u + gap / 2)
      u += gap
    }
  }
  aisles.push(u + o.A / 2)
  return { rects, aisles, bottom: z.y + rows * o.py + (split ? o.A : 0), seats: rows * per * b * o.perCol }
}

function trimRect(r: SeatRect, res: Rect, px: number, py: number): SeatRect | null {
  if (!rectsOverlap(r, res)) return r
  const opts: SeatRect[] = []
  const add = (w: number, h: number, right: boolean, bottom: boolean) => {
    const cols = Math.floor((w + 1) / px)
    const rows = Math.floor((h + 1) / py)
    if (cols < 1 || rows < 1) return
    const ww = cols * px
    const hh = rows * py
    opts.push({ x: right ? r.x + r.w - ww : r.x, y: bottom ? r.y + r.h - hh : r.y, w: ww, h: hh, rows, cols })
  }
  add(res.x - r.x, r.h, false, false)
  add(r.x + r.w - (res.x + res.w), r.h, true, false)
  add(r.w, res.y - r.y, false, false)
  add(r.w, r.y + r.h - (res.y + res.h), false, true)
  if (!opts.length) return null
  return opts.sort((a, b) => b.rows * b.cols - a.rows * a.cols)[0]
}

// ───────────────────────── 本体 ─────────────────────────

export function buildPlan(project: Project, spec: LayoutSpec, origin: 'rule' | 'ai' = 'rule'): Plan {
  const brief = project.brief
  const outline = project.venue.outline
  const A = clamp(brief.aisleMin || 1200, 800, 3000)
  const MA = Math.max(1800, Math.round((A * 1.5) / 100) * 100)
  const info = venueInfo(project)
  const R = info.R
  const mainW0 = pickMain(info.entrances)
  const side = chooseStageSide(spec.stageSide, R, mainW0 ? mainW0.side : null, mainW0 ? mainW0.c : null)
  const theta = SIDE_THETA[side]
  const f: Frame = { R, theta, cw: theta % 180 === 0 ? R.w : R.h, ch: theta % 180 === 0 ? R.h : R.w }
  const { cw, ch } = f

  const ctx: Ctx = {
    project,
    outline,
    f,
    solids: project.structure.filter((s) => isSolid(s)),
    clears: [],
    areas: [],
    placed: [],
    notes: [],
    boothNo: 1,
  }
  const notes = ctx.notes

  // 出入口（カノニカル座標）と前面のクリアランス
  const ents: Ent[] = info.entrances.map((e) => {
    const cc = toCanon(f, e.c.x, e.c.y)
    const u = clamp(cc.u, 0, cw)
    const v = clamp(cc.v, 0, ch)
    const d: [CSide, number][] = [['top', v], ['bottom', ch - v], ['left', u], ['right', cw - u]]
    d.sort((a, b) => a[1] - b[1])
    return { o: e.o, kind: e.kind, c: e.c, n: e.n, width: e.o.w, u, v, side: d[0][0] }
  })
  for (const e of ents) {
    const depth = e.kind === 'loading' ? 3000 : 2200
    const w = e.width + 400
    ctx.clears.push({ id: 'clr', type: 'zone', x: e.c.x + e.n.x * (depth / 2) - w / 2, y: e.c.y + e.n.y * (depth / 2) - depth / 2, w, h: depth, rot: e.o.rot })
  }
  const mainE = pickMain(ents)
  if (!mainE) notes.push('入口が未設定のため、図面の手前側を入口と仮定しています')
  const E: { u: number; v: number; side: CSide; width: number } = mainE || { u: cw / 2, v: ch, side: 'bottom', width: 1800 }
  if (mainE && mainE.side === 'top') notes.push('メイン入口がステージ側にあります。ステージ位置の指定を見直してください')

  const u0 = M
  const u1 = cw - M
  const v0 = M
  const v1 = ch - M
  let mu0 = u0
  let mu1 = u1
  const whole: Rect = { x: u0, y: v0, w: u1 - u0, h: v1 - v0 }
  const canonRectOf = (r: Rect): Rect => {
    const a = toCanon(f, r.x, r.y)
    const b = toCanon(f, r.x + r.w, r.y + r.h)
    return { x: Math.min(a.u, b.u), y: Math.min(a.v, b.v), w: Math.abs(b.u - a.u), h: Math.abs(b.v - a.v) }
  }

  // ── サイドバンド（展示・交流・飲食のための帯）
  let sideBand: Rect | null = null
  let sideLeft = false
  if (spec.side.use !== 'none') {
    const minW = Math.max(4500, spec.booths.d + MA + 600)
    const sbw = clamp(cw * (spec.side.ratio || 0.25), minW, cw * 0.45)
    if (cw - sbw < 8000) notes.push('会場幅が足りないためサイドエリアは省略しました')
    else {
      const entLeft = E.side === 'left' ? true : E.side === 'right' ? false : E.u < cw / 2
      sideLeft = spec.side.at === 'entrance' ? entLeft : !entLeft
      sideBand = { x: sideLeft ? u0 : u1 - sbw, y: v0, w: sbw, h: v1 - v0 }
      if (sideLeft) mu0 = u0 + sbw + MA / 2
      else mu1 = u1 - sbw - MA / 2
    }
  }
  const mW = mu1 - mu0
  const mC = (mu0 + mu1) / 2
  const mainArea: Rect = { x: mu0, y: v0, w: mW, h: v1 - v0 }

  // ── ステージ
  let stageBottom = v0
  let frontGap = 0
  let stageC: { u: number; v: number; w: number; d: number } | null = null
  let staffPlaced = false
  if (spec.stage.on) {
    const sc = spec.stage.scale || 1
    let sw = snap(clamp(mW * 0.42 * sc, 3600, Math.max(3600, Math.min(14400, mW - 2 * A))), 300)
    if (sw > mW - 1200) sw = Math.max(1800, snapDown(mW * 0.6, 300))
    let sd = snap(clamp(ch * 0.15 * sc, ch < 12000 ? 1200 : 2400, 4800), 300)
    if (sd > ch * 0.3) sd = Math.max(1200, snapDown(ch * 0.25, 300))
    const top = v0 + (brief.screen ? 450 : 0)
    if (brief.screen) put(ctx, W(ctx, 'screen', mC, v0 + 75, snap(Math.min(sw * 0.7, 8000), 100), 150))
    let st: Obj | null = W(ctx, 'stage', mC, top + sd / 2, sw, sd)
    if (ok(ctx, st, 0)) put(ctx, st)
    else {
      const alt = near(ctx, 'stage', sw, sd, 0, mC, top + sd / 2, { x: mu0, y: v0, w: mW, h: Math.min(v1 - v0, sd + 3000) }, 0)
      if (alt) st = alt
      else {
        put(ctx, st)
        notes.push('ステージが柱・固定設備と干渉しています。位置を調整してください')
      }
    }
    const c = toCanon(f, st.x + st.w / 2, st.y + st.h / 2)
    stageC = { u: c.u, v: c.v, w: sw, d: sd }
    stageBottom = c.v + sd / 2
    frontGap = clamp(ch * 0.16, 1500, Math.max(2700, MA))
    if (spec.seating.style === 'standing' && brief.eventType === 'live') {
      // ステージ前に柵を置き、その手前からスタンディング
      frontGap = 1900
      put(ctx, W(ctx, 'barricade', c.u, stageBottom + 1100, Math.min(sw + 1600, mW - 1000), 150))
    }
    if (brief.podium) put(ctx, W(ctx, 'podium', c.u - sw / 2 + Math.max(700, sw * 0.16), stageBottom - 900, 900, 600))
    if (brief.staff) {
      const room = (mW - sw) / 2 - 900
      if (room >= 2400) {
        const sbw2 = Math.min(3600, room)
        const bh = Math.max(1800, Math.min(3000, Math.max(2400, sd), stageBottom + frontGap - A - v0))
        const right = E.u < cw / 2
        for (const r of [right, !right]) {
          const o = W(ctx, 'staff', r ? mu1 - sbw2 / 2 : mu0 + sbw2 / 2, v0 + bh / 2, sbw2, bh)
          if (ok(ctx, o, 0)) {
            put(ctx, o)
            staffPlaced = true
            break
          }
        }
      }
    }
  }

  // ── ホワイエ（入口側の帯）と受付
  const nRec = Math.max(0, Math.round(spec.reception))
  let D = 2300
  let fd = A + 300
  // 奥行きの浅い会場では受付用の帯を取らず、受付のまわりだけ客席を避ける
  const compact = ch - stageBottom - frontGap < 9000
  if (compact) D = 1500
  if (nRec > 0 && E.side === 'bottom' && !compact) fd = D + 1100 + A
  if (spec.booths.mode === 'wall' && spec.booths.count > 0) fd = Math.max(fd, spec.booths.d + MA)
  const fdMax = Math.max(2400, (ch - stageBottom - frontGap) * 0.38)
  if (fd > fdMax) {
    fd = fdMax
    D = Math.max(1500, fd - 1100 - A)
  }
  const foyerTop = v1 - fd
  const reserved: Rect[] = []
  let recRow: { u: number; v: number; L: number; horiz: boolean } | null = null
  if (nRec > 0) {
    const L = nRec * 1800 + (nRec - 1) * 150
    let uc: number
    let vc: number
    let rot = 0
    const lo = Math.min(mu0 + L / 2 + 600, mC)
    const hi = Math.max(mu1 - L / 2 - 600, mC)
    const vlo = Math.min(stageBottom + L / 2 + 600, ch / 2)
    const vhi = Math.max(v1 - L / 2 - 600, ch / 2)
    if (E.side === 'bottom') { rot = 0; uc = clamp(E.u, lo, hi); vc = v1 - D - 550 }
    else if (E.side === 'top') { rot = 180; uc = clamp(E.u, lo, hi); vc = v0 + D + 550 }
    else if (E.side === 'left') { rot = 90; uc = u0 + D + 550; vc = clamp(E.v, vlo, vhi) }
    else { rot = 270; uc = u1 - D - 550; vc = clamp(E.v, vlo, vhi) }
    const horiz = rot % 180 === 0
    let placedRec = 0
    for (let i = 0; i < nRec; i++) {
      const off = (i - (nRec - 1) / 2) * 1950
      const cu = horiz ? uc + off : uc
      const cv = horiz ? vc : vc + off
      const o = W(ctx, 'reception', cu, cv, 1800, 1100, rot)
      if (ok(ctx, o, 0, { self: 'reception' })) { put(ctx, o); placedRec++ }
      else if (near(ctx, 'reception', 1800, 1100, rot, cu, cv, whole, 150, {}, { self: 'reception' })) placedRec++
    }
    if (placedRec < nRec) notes.push(`受付 ${nRec}台中 ${placedRec}台を配置`)
    recRow = { u: uc, v: vc, L, horiz }
    if (horiz) {
      const top = E.side === 'bottom' ? vc - 1450 : v0
      const bot = E.side === 'bottom' ? v1 : vc + 1450
      reserved.push({ x: uc - L / 2 - 900, y: top, w: L + 1800, h: bot - top })
    } else {
      const left = E.side === 'left' ? u0 : uc - 1450
      const right = E.side === 'left' ? uc + 1450 : u1
      reserved.push({ x: left, y: vc - L / 2 - 900, w: right - left, h: L + 1800 })
    }
    if (brief.cloak) {
      const dir = E.u < cw / 2 ? 1 : -1
      const au = horiz ? uc + dir * (L / 2 + 2600) : uc
      const av = horiz ? vc : vc + (E.v < ch / 2 ? 1 : -1) * (L / 2 + 2600)
      if (!near(ctx, 'cloak', 3000, 1500, 0, au, av, whole, A)) notes.push('クロークを配置できませんでした')
    }
  }

  // ── サイドバンドの中身
  const foodN = Math.max(0, Math.round(brief.food || 0))
  const merchN = Math.max(0, Math.round(brief.merch || 0))
  let boothsLeft = Math.max(0, Math.round(spec.booths.count))
  const bw = clamp(spec.booths.w || 3000, 1500, 9000)
  const bd = clamp(spec.booths.d || 3000, 1500, 9000)
  const boothAisle = Math.max(A, spec.booths.mode === 'grid' ? 2000 : 1500)
  let loungePlaced = false
  let foodLeft = foodN
  let merchLeft = merchN

  const gridFill = (z: Rect, n: number, mainAisle = 0): number => {
    if (n <= 0 || z.w < bw || z.h < bd) return 0
    if (mainAisle && z.w >= bw * 4 + mainAisle) {
      const hw = (z.w - mainAisle) / 2
      const n1 = Math.ceil(n / 2)
      const a = gridFill({ x: z.x, y: z.y, w: hw, h: z.h }, n1)
      return a + gridFill({ x: z.x + hw + mainAisle, y: z.y, w: hw, h: z.h }, n - a)
    }
    const perRowMax = Math.floor(z.w / bw)
    const nSeg = Math.ceil(perRowMax / 6)
    const perRow = Math.floor((z.w - (nSeg - 1) * boothAisle) / bw)
    if (perRow < 1) return 0
    const depth = (r: number) => r * bd + (Math.floor(r / 2) + (r % 2) - 1) * boothAisle
    let rowsN = Math.ceil(n / perRow)
    while (rowsN > 1 && depth(rowsN) > z.h) rowsN--
    if (depth(rowsN) > z.h + 1) return 0
    const q = Math.min(perRow, Math.ceil(n / rowsN))
    const segs = Math.ceil(q / 6)
    const segSize = Math.ceil(q / segs)
    const rowW = q * bw + (segs - 1) * boothAisle
    const x0 = z.x + (z.w - rowW) / 2
    let y = z.y + (z.h - depth(rowsN)) / 2
    let done = 0
    const rowAt = (yy: number, rot: number) => {
      for (let k = 0; k < q && done < n; k++) {
        const x = x0 + k * bw + Math.floor(k / segSize) * boothAisle
        const o = W(ctx, 'booth', x + bw / 2, yy + bd / 2, bw, bd, rot, { props: { no: ctx.boothNo } })
        if (ok(ctx, o, 300, { self: 'booth' })) {
          put(ctx, o)
          ctx.boothNo++
          done++
        }
      }
    }
    let r = rowsN
    if (r % 2 === 1) {
      rowAt(y, 0)
      y += bd + boothAisle
      r--
    }
    while (r > 0) {
      rowAt(y, 180)
      rowAt(y + bd, 0)
      y += bd * 2 + boothAisle
      r -= 2
    }
    return done
  }

  type WallItem = { type: ObjType; len: number; dep: number; numbered?: boolean }
  const BOOTH: WallItem = { type: 'booth', len: bw, dep: bd, numbered: true }
  const wallRun = (n: number, region: Rect, sides: CSide[], fromRight: boolean, vMin: number, fromTop = false, item: WallItem = BOOTH): number => {
    const iw = item.len
    const idp = item.dep
    let done = 0
    // 置けたら true。小間の正面（開口側）に通路幅ぶんの空きがあることも確認する
    const tryPut = (cu: number, cv: number, rot: number, pu: number, pv: number, eu: number, ev: number): boolean => {
      if (done >= n) return false
      const o = W(ctx, item.type, cu, cv, iw, idp, rot, item.numbered ? { props: { no: ctx.boothNo } } : {})
      if (!ok(ctx, o, A, { self: item.type })) return false
      const probe = W(ctx, 'zone', pu, pv, eu, ev, 0)
      if (!ok(ctx, probe, 0, { noAreas: true, noClears: true })) return false
      put(ctx, o)
      if (item.numbered) ctx.boothNo++
      done++
      return true
    }
    const step = 250
    for (const s of sides) {
      if (s === 'bottom' || s === 'top') {
        const cv = s === 'bottom' ? region.y + region.h - idp / 2 : region.y + idp / 2
        const pv = s === 'bottom' ? cv - idp / 2 - A / 2 : cv + idp / 2 + A / 2
        let u = fromRight ? region.x + region.w - iw : region.x
        while (done < n && u >= region.x - 1 && u <= region.x + region.w - iw + 1) {
          const hit = tryPut(u + iw / 2, cv, s === 'bottom' ? 180 : 0, u + iw / 2, pv, iw - 200, A)
          u += (fromRight ? -1 : 1) * (hit ? iw : step)
        }
      } else {
        const top = Math.max(region.y, vMin)
        const cu = s === 'left' ? region.x + idp / 2 : region.x + region.w - idp / 2
        const pu = s === 'left' ? cu + idp / 2 + A / 2 : cu - idp / 2 - A / 2
        let v = fromTop ? top : region.y + region.h - iw
        while (done < n && v >= top - 1 && v <= region.y + region.h - iw + 1) {
          const hit = tryPut(cu, v + iw / 2, s === 'left' ? 270 : 90, pu, v + iw / 2, A, iw - 200)
          v += (fromTop ? 1 : -1) * (hit ? iw : step)
        }
      }
    }
    return done
  }
  if (sideBand) {
    const sb = inset(sideBand, 300)
    let cursor = sb.y
    const use = spec.side.use
    if ((use === 'booths' || use === 'mix') && boothsLeft > 0) {
      const zone = { x: sb.x, y: sb.y, w: sb.w, h: use === 'mix' ? sb.h * 0.62 : sb.h }
      const before = ctx.placed.length
      // まず外壁沿いに一列。入りきらない分は帯の中に島で並べる
      let done = wallRun(boothsLeft, { x: sideBand.x, y: sideBand.y, w: sideBand.w, h: use === 'mix' ? sideBand.h * 0.8 : sideBand.h }, [sideLeft ? 'left' : 'right'], false, v0, true)
      if (done < boothsLeft) done += gridFill({ x: sideLeft ? zone.x + bd + boothAisle : zone.x, y: zone.y, w: zone.w - bd - boothAisle, h: zone.h }, boothsLeft - done)
      boothsLeft -= done
      if (done > 0) {
        let maxV = sb.y
        for (const o of ctx.placed.slice(before)) {
          const c = toCanon(f, o.x + o.w / 2, o.y + o.h / 2)
          maxV = Math.max(maxV, c.v + bd / 2)
        }
        cursor = maxV + MA
      }
    }
    let stallsDepth = 0
    if (use === 'fnb' || use === 'mix') {
      const wantFood = foodLeft > 0 ? foodLeft : use === 'fnb' ? 2 : 0
      const band: Rect = { x: sideBand.x, y: sideBand.y, w: sideBand.w, h: sideBand.h }
      const outer: CSide = sideLeft ? 'left' : 'right'
      const f1 = wallRun(wantFood, band, [outer], false, cursor, true, { type: 'food', len: 3000, dep: 2000 })
      foodLeft = Math.max(0, foodLeft - f1)
      const m1 = wallRun(merchLeft, band, [outer], false, cursor, true, { type: 'merch', len: 3000, dep: 2000 })
      merchLeft -= m1
      if (f1 + m1 > 0) stallsDepth = 2000 + A
    }
    if (use === 'lounge' || use === 'mix' || use === 'fnb') {
      const lz = { x: sideLeft ? sb.x + stallsDepth : sb.x, y: cursor, w: sb.w - stallsDepth, h: sb.y + sb.h - cursor }
      if (lz.w >= 2400 && lz.h >= 3000) {
        for (let lh = Math.min(lz.h, 10000); lh >= 3000 && !loungePlaced; lh -= 500) {
          for (const top of [lz.y, lz.y + lz.h - lh]) {
            const o = W(ctx, 'lounge', lz.x + lz.w / 2, top + lh / 2, lz.w, lh)
            if (ok(ctx, o, 0)) {
              put(ctx, o)
              loungePlaced = true
              break
            }
          }
        }
      }
    }
  }

  // ── 客席
  const style = spec.seating.style
  const wantSeats = style !== 'none' && spec.seating.count > 0
  const azTop = stageBottom + frontGap
  const az: Rect = { x: mu0 + A, y: azTop, w: mW - 2 * A, h: foyerTop - azTop }
  let seatsBottom = azTop
  let aisles: number[] = [mu0 + A / 2, mu1 - A / 2]
  let seatBox: Rect | null = null
  const structBlockers = seatBlockers(project.structure, null)
  let seated = 0
  let islandPlaced = false
  // カノニカル座標での外接矩形
  const canonBox = (o: Obj, growBy = 0): Rect => {
    const cs = [
      [o.x - growBy, o.y - growBy], [o.x + o.w + growBy, o.y - growBy], [o.x + o.w + growBy, o.y + o.h + growBy], [o.x - growBy, o.y + o.h + growBy],
    ]
    const cx = o.x + o.w / 2
    const cy = o.y + o.h / 2
    const r = rad(o.rot || 0)
    let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity
    for (const [px, py] of cs) {
      const wx = cx + (px - cx) * Math.cos(r) - (py - cy) * Math.sin(r)
      const wy = cy + (px - cx) * Math.sin(r) + (py - cy) * Math.cos(r)
      const c = toCanon(f, wx, wy)
      a0 = Math.min(a0, c.u); a1 = Math.max(a1, c.u); b0 = Math.min(b0, c.v); b1 = Math.max(b1, c.v)
    }
    return { x: a0, y: b0, w: a1 - a0, h: b1 - b0 }
  }
  // 客席が避けるべき範囲：受付まわり・出入口の前・すでに置いた設備
  const seatObstacles = (): Rect[] => [
    ...reserved,
    ...ctx.placed.filter((o) => isSolid(o) && o.type !== 'seat_block').map((o) => canonBox(o, Math.max(500, A - 200))),
  ]
  let standingObj: Obj | null = null
  const grow = (r: Rect) => {
    if (!seatBox) seatBox = { ...r }
    else {
      const x0 = Math.min(seatBox.x, r.x)
      const y0 = Math.min(seatBox.y, r.y)
      const x1 = Math.max(seatBox.x + seatBox.w, r.x + r.w)
      const y1 = Math.max(seatBox.y + seatBox.h, r.y + r.h)
      seatBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
  }
  const placeRows = (z: Rect, count: number, conf: RowConf, label?: string, withIsland = false): RowFill => {
    const obst = seatObstacles()
    // 音響卓・カメラ台は客席後方の中央に「島」として置き、重なる席だけ間引く
    const islands = (fl: RowFill): Obj[] => {
      if (!withIsland || !fl.rects.length || !spec.stage.on || count < 100) return []
      const out: Obj[] = []
      const cv = fl.bottom - 750 - 60
      if (brief.foh) out.push(W(ctx, 'foh', mC, cv, 2400, 1500))
      if (brief.camera) out.push(W(ctx, 'camera', mC + (brief.foh ? 2100 : 0), cv, 1500, 1500))
      return out
    }
    let fill = fillRows(z, count, conf)
    const emit = (fl: RowFill, commit: boolean): number => {
      let n = 0
      const isl = islands(fl)
      const env: SeatEnv = { blockers: [...structBlockers, ...isl], outline }
      if (commit && isl.length) {
        isl.forEach((o) => put(ctx, o))
        islandPlaced = true
      }
      for (const r0 of fl.rects) {
        let r: SeatRect | null = r0
        for (const res of obst) if (r) r = trimRect(r, res, conf.px, conf.py)
        if (!r) continue
        const o = W(ctx, 'seat_block', r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, 0, { label, props: { style: conf.style, rows: r.rows, cols: r.cols } })
        n += seatCount(o, env)
        if (commit) {
          put(ctx, o)
          grow(r)
        }
      }
      return n
    }
    const first = emit(fill, false)
    if (first < count && first > 0) {
      // 柱や音響卓で減った分を補う（1回だけ）
      const retry = fillRows(z, Math.ceil(count + (count - first) * 1.25), conf)
      if (emit(retry, false) > first) fill = retry
    }
    seated += emit(fill, true)
    return fill
  }

  if (wantSeats && az.w > 1500 && az.h > 1500) {
    let z = { ...az }
    if (style === 'theater' || style === 'classroom') {
      if (spec.vip > 0 && style === 'theater') {
        const d = SEAT.vip
        const before = seated
        const vf = placeRows(z, spec.vip, { style: 'vip', px: d.pitchX, py: d.pitchY, maxPer: 14, perCol: 1, centerAisle: spec.seating.centerAisle, A, MA, dc: Math.ceil(spec.vip / (spec.vip > 28 ? 2 : 1)) }, '来賓席')
        if (seated > before) z = { ...z, y: vf.bottom + 400, h: z.y + z.h - (vf.bottom + 400) }
      }
      const d = style === 'theater' ? SEAT.theater : SEAT.classroom
      const before = seated
      const gf = placeRows(z, spec.seating.count, {
        style,
        px: d.pitchX,
        py: d.pitchY,
        maxPer: style === 'theater' ? 14 : 3,
        perCol: style === 'theater' ? 1 : 3,
        centerAisle: spec.seating.centerAisle,
        A,
        MA,
      }, undefined, true)
      const got = seated - before
      if (gf.rects.length) {
        seatsBottom = gf.bottom
        aisles = gf.aisles
      }
      if (got < spec.seating.count) notes.push(`客席 ${spec.seating.count}席の要件に対し ${got}席を配置（スペース不足）`)
    } else if (style === 'round') {
      const box = 2800
      const pitch = 3300
      const n = Math.ceil(spec.seating.count / 10)
      // ホワイエ側まで使う（受付・出入口の前は ok() が避ける）
      const zt: Rect = { x: z.x, y: z.y, w: z.w, h: v1 - 400 - z.y }
      const colsMax = Math.max(1, Math.floor((zt.w + pitch - box) / pitch))
      const rowsMax = Math.max(1, Math.floor((zt.h + pitch - box) / pitch))
      const grid = (cols: number): Obj[] => {
        const rows = Math.min(rowsMax, Math.ceil(n / cols))
        const out: Obj[] = []
        const rowW = cols * pitch - (pitch - box)
        for (let i = 0; i < rows; i++)
          for (let j = 0; j < cols; j++) {
            const o = W(ctx, 'round_table', zt.x + (zt.w - rowW) / 2 + j * pitch + box / 2, zt.y + i * pitch + box / 2, box, box, 0, { props: { seats: 10 } })
            if (ok(ctx, o, A, { self: 'round_table', selfGap: 300 })) out.push(o)
          }
        return out
      }
      let bestGrid: Obj[] = []
      for (let c = clamp(Math.ceil(Math.sqrt((n * zt.w) / Math.max(1, zt.h))), 1, colsMax); c <= colsMax; c++) {
        const g = grid(c)
        if (g.length > bestGrid.length) bestGrid = g
        if (g.length >= n) break
      }
      const use = bestGrid.slice(0, n)
      for (const o of use) {
        put(ctx, o)
        seated += 10
        const c = toCanon(f, o.x + o.w / 2, o.y + o.h / 2)
        grow({ x: c.u - box / 2, y: c.v - box / 2, w: box, h: box })
        seatsBottom = Math.max(seatsBottom, c.v + box / 2)
      }
      if (use.length < n) notes.push(`円卓 ${n}卓の要件に対し ${use.length}卓を配置（スペース不足）`)
    } else if (style === 'standing') {
      const density = brief.eventType === 'live' ? 2.5 : brief.eventType === 'party' ? 1.2 : 1.5
      const needH = ((spec.seating.count / density) * 1e6) / z.w
      const hh = clamp(needH, Math.min(3000, z.h), z.h)
      standingObj = W(ctx, 'standing', z.x + z.w / 2, z.y + hh / 2, z.w, hh, 0, { props: { density } })
      put(ctx, standingObj)
      grow({ x: z.x, y: z.y, w: z.w, h: hh })
      seatsBottom = z.y + hh
      const cap = Math.floor(((z.w * hh) / 1e6) * density)
      if (cap < spec.seating.count) notes.push(`スタンディング ${spec.seating.count}人の要件に対し 約${cap}人分（${density}人/㎡の目安）`)
    }
  } else if (wantSeats) notes.push('客席を置くスペースが確保できませんでした')

  // ── 音響卓・カメラ
  const farU = E.u < cw / 2 ? u1 - 1800 : u0 + 1800
  const below: Rect = { x: mu0, y: stageBottom, w: mW, h: v1 - stageBottom }
  if (!islandPlaced && spec.stage.on && brief.foh) {
    const tiny = cw < 14000 || spec.seating.count < 100
    const fw = tiny ? 1500 : 2400
    const fh = tiny ? 900 : 1500
    if (!near(ctx, 'foh', fw, fh, 0, tiny ? farU : mC, seatsBottom + A + fh / 2, below, tiny ? 600 : A, {}, { noAreas: true })) notes.push('音響・照明卓を配置できませんでした')
  }
  if (!islandPlaced && spec.stage.on && brief.camera) {
    near(ctx, 'camera', 1500, 1500, 0, mC + (brief.foh ? 3900 : 0), seatsBottom + A + 750, below, A, {}, { noAreas: true })
  }

  // ── 展示ブース
  const fzTop = wantSeats ? seatsBottom + MA : stageBottom + frontGap
  const fz: Rect = { x: mu0 + 300, y: fzTop, w: mW - 600, h: foyerTop - fzTop }
  if (boothsLeft > 0) {
    const mode = spec.booths.mode
    const fromRight = E.u < cw / 2
    const wallRegion: Rect = { x: mu0, y: v0, w: mW, h: v1 - v0 }
    if (mode === 'wall' || mode === 'side') {
      boothsLeft -= wallRun(boothsLeft, wallRegion, ['bottom', fromRight ? 'right' : 'left', fromRight ? 'left' : 'right'], fromRight, stageBottom + frontGap)
      if (boothsLeft > 0 && fz.h >= bd) boothsLeft -= gridFill(fz, boothsLeft)
    } else if (mode === 'perimeter') {
      const sides: CSide[] = spec.stage.on ? ['bottom', 'left', 'right'] : ['bottom', 'left', 'right', 'top']
      boothsLeft -= wallRun(boothsLeft, wallRegion, sides, fromRight, stageBottom + (spec.stage.on ? frontGap : 0))
      if (boothsLeft > 0) boothsLeft -= gridFill(inset(fz, bd + boothAisle), boothsLeft)
    } else {
      boothsLeft -= gridFill(fz, boothsLeft, spec.booths.mainAisle || 0)
    }
  }
  // メインの長方形に入らなかった分は、会場の残りの広い場所（L字の袖など）へ
  const R2w = secondRect(project, R)
  const R2 = R2w ? inset(canonRectOf(R2w), 500) : null
  if (R2 && boothsLeft > 0) boothsLeft -= gridFill(R2, boothsLeft)
  if (spec.booths.count > 0 && boothsLeft > 0) notes.push(`展示ブース ${spec.booths.count}小間の要件に対し ${spec.booths.count - boothsLeft}小間を配置（スペース不足）`)

  // ── そのほかの設備
  const anchors = (nearKey: ExtraReq['near']): [number, number] => {
    switch (nearKey) {
      case 'entrance':
        return E.side === 'bottom' ? [E.u, ch - 4500] : E.side === 'left' ? [4500, E.v] : E.side === 'right' ? [cw - 4500, E.v] : [E.u, 4500]
      case 'stage':
        return stageC ? [stageC.u + (E.u < cw / 2 ? 1 : -1) * (stageC.w / 2 + 2500), v0 + 1500] : [mC, v0 + 1500]
      case 'rear':
        return [mC, v1 - 1500]
      case 'rear-corner':
        return [farU, v1 - 1500]
      case 'side':
        return [farU, ch / 2]
      case 'exit': {
        const ex = ents.find((e) => e.kind === 'emergency') || ents.find((e) => e.kind === 'exit')
        return ex ? [clamp(ex.u, 2500, cw - 2500), clamp(ex.v, 2500, ch - 2500)] : [farU, v1 - 1500]
      }
      case 'loading': {
        const ld = ents.find((e) => e.kind === 'loading')
        return ld ? [clamp(ld.u, 3000, cw - 3000), clamp(ld.v, 3000, ch - 3000)] : [farU, v0 + 1500]
      }
      default:
        return [cw / 2, ch / 2]
    }
  }
  const addNear = (type: ObjType, w: number, h: number, key: ExtraReq['near'], label?: string, off = 0): boolean => {
    const [au, av] = anchors(key)
    const o = near(ctx, type, w, h, 0, au, av + off, whole, A, label ? { label } : {})
    if (!o) notes.push(`${label || CATALOG[type].name}を配置できませんでした`)
    return !!o
  }

  if (brief.lounge && !loungePlaced && R2 && R2.w >= 4000 && R2.h >= 3500) {
    if (near(ctx, 'lounge', Math.min(R2.w - 600, 9000), Math.min(R2.h - 600, 6000), 0, R2.x + R2.w / 2, R2.y + R2.h / 2, R2, 300)) loungePlaced = true
  }
  if (brief.lounge && !loungePlaced) {
    const free = fz.h - (spec.booths.mode === 'grid' ? 99999 : 0)
    if (free >= 3500) {
      const lw = Math.min(fz.w * 0.5, 9000)
      const lh = Math.min(fz.h - 600, 5000)
      const [au, av] = anchors('rear-corner')
      const o = near(ctx, 'lounge', lw, lh, 0, au, av, fz, 300)
      if (o) loungePlaced = true
    }
    if (!loungePlaced) {
      const [au, av] = anchors('side')
      if (!near(ctx, 'lounge', 5000, 3500, 0, au, av, whole, 300)) notes.push('交流ラウンジを配置できませんでした')
    }
  }
  {
    const region: Rect = { x: mu0, y: v0, w: mW, h: v1 - v0 }
    const far: CSide = E.u < cw / 2 ? 'right' : 'left'
    const vMin = stageBottom + frontGap
    if (merchLeft > 0) merchLeft -= wallRun(merchLeft, region, ['bottom'], E.u >= cw / 2, vMin, false, { type: 'merch', len: 3000, dep: 2000 })
    if (foodLeft > 0) foodLeft -= wallRun(foodLeft, region, [far, 'bottom', far === 'right' ? 'left' : 'right'], E.u < cw / 2, vMin, false, { type: 'food', len: 3000, dep: 2000 })
  }
  for (let i = 0; i < foodLeft; i++) addNear('food', 3000, 2000, 'side')
  for (let i = 0; i < merchLeft; i++) addNear('merch', 3000, 2000, 'entrance')
  if (brief.firstaid) addNear('firstaid', 3000, 2400, 'exit')
  if (brief.staff && !staffPlaced) addNear('staff', 3600, 3000, 'rear-corner')
  for (const ex of spec.extras || []) {
    const c = CATALOG[ex.type]
    if (!c || c.layer === 'structure') continue
    for (let i = 0; i < clamp(ex.count || 1, 1, 30); i++) addNear(ex.type, ex.w || c.w, ex.h || c.h, ex.near || 'center', ex.label)
  }

  // ── ゾーン（プレゼン用の色分け。編集画面では既定で非表示のレイヤー）
  const zone = (r: Rect, label: string, zcat: string) => {
    if (r.w < 1500 || r.h < 1500) return
    put(ctx, W(ctx, 'zone', r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, 0, { label, props: { zcat } }))
  }
  if (stageC) zone({ x: mu0, y: v0, w: mW, h: stageBottom + frontGap * 0.45 - v0 }, 'ステージエリア', 'production')
  const sbx = seatBox as Rect | null
  if (sbx) zone({ x: sbx.x - 500, y: sbx.y - 300, w: sbx.w + 1000, h: sbx.h + 600 }, style === 'standing' ? 'スタンディングエリア' : '客席エリア', 'seating')
  if (nRec > 0 && E.side === 'bottom') zone({ x: mu0, y: foyerTop, w: mW, h: v1 - foyerTop }, '受付・ホワイエ', 'service')
  if (sideBand) {
    const use = spec.side.use
    zone(inset(sideBand, 100), use === 'fnb' ? '飲食・交流エリア' : use === 'lounge' ? '交流エリア' : '展示・交流エリア', use === 'fnb' ? 'fnb' : use === 'lounge' ? 'service' : 'exhibit')
  }
  if (spec.booths.mode === 'grid' && spec.booths.count > 0 && fz.h > 2000) zone(fz, '展示エリア', 'exhibit')

  // ── 動線（什器を避けて通路を通るよう自動ルーティング）
  const rm = buildRouteMap(project, ctx.placed)
  const addFlow = (kind: FlowKind, from: Pt, to: Pt) => {
    const pts = route(rm, from, to)
    if (pts) ctx.placed.push(flowObj(kind, pts, uid()))
  }
  const frontV = stageC ? stageBottom + Math.min(frontGap / 2, 1400) : v0 + 2000
  if (mainE) {
    addFlow('visitor', { x: mainE.c.x - mainE.n.x * 150, y: mainE.c.y - mainE.n.y * 150 }, toWorld(f, mC, frontV))
  }
  const ld = ents.find((e) => e.kind === 'loading')
  if (ld && stageC) {
    const tu = stageC.u + (ld.u < stageC.u ? -1 : 1) * (stageC.w / 2 + 800)
    addFlow('load', { x: ld.c.x - ld.n.x * 150, y: ld.c.y - ld.n.y * 150 }, toWorld(f, clamp(tu, mu0 + 600, mu1 - 600), stageC.v))
  }
  if (sbx) {
    for (const e of ents.filter((x) => x.kind === 'emergency' || x.kind === 'exit').slice(0, 3)) {
      const su = clamp(e.u, sbx.x + 600, sbx.x + sbx.w - 600)
      const sv = clamp(e.v, sbx.y + 600, sbx.y + sbx.h - 600)
      addFlow('evac', toWorld(f, su, sv), { x: e.c.x + e.n.x * 150, y: e.c.y + e.n.y * 150 })
    }
  }

  return {
    id: uid('p'),
    name: `${spec.key}案`,
    concept: spec.name,
    rationale: [spec.concept, ...(spec.rationale || [])].filter(Boolean),
    origin,
    objects: ctx.placed,
    notes,
    spec,
  }
}

// ───────────────────────── イベント種別ごとの方針 ─────────────────────────

export function defaultSpecs(b: Brief): LayoutSpec[] {
  const fixedSide = b.stageSide !== 'auto'
  const sideA: LayoutSpec['stageSide'] = fixedSide ? (b.stageSide as Side) : 'opposite'
  const sideC: LayoutSpec['stageSide'] = fixedSide ? (b.stageSide as Side) : 'alt'
  const seats = b.seats > 0 ? b.seats : b.attendees
  const base = (key: string, name: string, concept: string, p: Partial<LayoutSpec>): LayoutSpec => ({
    key,
    name,
    concept,
    rationale: [],
    stageSide: sideA,
    stage: { on: b.stage, scale: 1 },
    seating: { style: 'theater', count: seats, centerAisle: true },
    vip: b.vipSeats || 0,
    side: { use: 'none', ratio: 0.26, at: 'entrance' },
    booths: { count: b.booths, w: b.boothW, d: b.boothD, mode: 'wall' },
    reception: b.reception,
    extras: [],
    ...p,
  })
  const pick = (auto: LayoutSpec['seating']['style']): LayoutSpec['seating']['style'] => (b.seatingStyle === 'auto' ? auto : b.seatingStyle)

  switch (b.eventType) {
    case 'exhibition': {
      const sem = b.stage ? Math.min(seats, Math.max(30, Math.round(b.attendees * 0.15))) : 0
      const seating = { style: (sem > 0 ? pick('theater') : 'none') as LayoutSpec['seating']['style'], count: sem, centerAisle: false }
      return [
        base('A', '小間数最大', '島型の小間を通路で区切り、出展スペースを最大化するレイアウト', { stage: { on: b.stage, scale: 0.6 }, seating, booths: { count: b.booths, w: b.boothW, d: b.boothD, mode: 'grid' } }),
        base('B', 'メイン通路型', '入口から奥へ太いメイン通路を通し、どの小間にも人が流れるレイアウト', { stage: { on: b.stage, scale: 0.6 }, seating, booths: { count: b.booths, w: b.boothW, d: b.boothD, mode: 'grid', mainAisle: 3600 } }),
        base('C', '回遊型', '壁沿いに小間を並べ、中央を交流・商談スペースにして回遊を促すレイアウト', { stage: { on: b.stage, scale: 0.6 }, seating, booths: { count: b.booths, w: b.boothW, d: b.boothD, mode: 'perimeter' }, extras: [{ type: 'lounge', count: 1, near: 'center', w: 7000, h: 5000 }] }),
      ]
    }
    case 'ceremony':
      return [
        base('A', 'シアター形式', '中央に花道を通し、来賓席を前方にまとめる式典の基本レイアウト', { seating: { style: pick('theater'), count: seats, centerAisle: true } }),
        base('B', '円卓形式', '円卓で着席し、式典から祝賀会へそのまま移れるレイアウト', { seating: { style: 'round', count: seats, centerAisle: false }, vip: 0 }),
        fixedSide
          ? base('C', 'スクール形式', '机付きで資料や記念品を置ける、落ち着いたレイアウト', { seating: { style: 'classroom', count: seats, centerAisle: true }, vip: 0 })
          : base('C', 'ワイド型', 'ステージを別の壁面に取り、客席の奥行きを浅くして全員を近づけるレイアウト', { stageSide: sideC, seating: { style: pick('theater'), count: seats, centerAisle: true } }),
      ]
    case 'party':
      return [
        base('A', '着席円卓', '全員が円卓に着席し、料理ステーションを片側にまとめるレイアウト', { seating: { style: 'round', count: seats, centerAisle: false }, side: { use: 'fnb', ratio: 0.2, at: 'far' }, vip: 0 }),
        base('B', '立食スタンディング', '中央を広く空け、歓談しながら回遊できる立食レイアウト', { seating: { style: 'standing', count: b.attendees, centerAisle: false }, side: { use: 'fnb', ratio: 0.24, at: 'far' }, vip: 0 }),
        base('C', 'ハーフ＆ハーフ', '半数は円卓に着席、残りはラウンジで立食の併用レイアウト', { seating: { style: 'round', count: Math.ceil(seats / 2), centerAisle: false }, side: { use: 'lounge', ratio: 0.32, at: 'entrance' }, vip: 0 }),
      ]
    case 'live':
      return [
        base('A', 'スタンディング最大', 'ステージ前を最大限スタンディングに充てる動員重視のレイアウト', { stage: { on: true, scale: 1.15 }, seating: { style: pick('standing'), count: b.attendees, centerAisle: false }, vip: 0 }),
        base('B', '飲食・物販充実', '片側に飲食・物販をまとめ、滞在時間と客単価を伸ばすレイアウト', { stage: { on: true, scale: 1 }, seating: { style: pick('standing'), count: b.attendees, centerAisle: false }, vip: 0, side: { use: 'fnb', ratio: 0.24, at: 'entrance' } }),
        fixedSide
          ? base('C', '着席＋スタンディング', '後方に着席エリアを設け、ゆっくり観たい来場者にも対応するレイアウト', { stage: { on: true, scale: 1 }, seating: { style: 'theater', count: Math.ceil(b.attendees * 0.5), centerAisle: true }, vip: 0 })
          : base('C', 'ワイドステージ', 'ステージを長辺側に取り、どこからでも近く観られるレイアウト', { stageSide: sideC, stage: { on: true, scale: 1.15 }, seating: { style: pick('standing'), count: b.attendees, centerAisle: false }, vip: 0 }),
      ]
    default: {
      const st = pick('theater')
      return [
        base('A', 'ステージ重視', '客席を中央にまとめ、全席からステージが見やすい王道レイアウト', { seating: { style: st, count: seats, centerAisle: true } }),
        base('B', '交流重視', '展示・交流スペースを横に広く取り、休憩時間の回遊を促すレイアウト', {
          stage: { on: b.stage, scale: 0.85 },
          seating: { style: st, count: seats, centerAisle: false },
          side: { use: b.booths > 0 ? 'mix' : 'lounge', ratio: 0.2, at: 'entrance' },
          booths: { count: b.booths, w: b.boothW, d: b.boothD, mode: 'side' },
        }),
        fixedSide
          ? base('C', st === 'classroom' ? 'シアター形式' : 'スクール形式', st === 'classroom' ? '椅子のみで席数を最大化するレイアウト' : '机付きでメモやPC作業がしやすいレイアウト', { seating: { style: st === 'classroom' ? 'theater' : 'classroom', count: seats, centerAisle: true } })
          : base('C', 'ワイドステージ', 'ステージを別の壁面に取り、客席の奥行きを浅くして登壇者との距離を縮めるレイアウト', { stageSide: sideC, seating: { style: st, count: seats, centerAisle: true } }),
      ]
    }
  }
}

export function generatePlans(project: Project): Plan[] {
  return defaultSpecs(project.brief).map((s) => buildPlan(project, s, 'rule'))
}

const STYLES = ['theater', 'classroom', 'round', 'standing', 'none']
const SIDES = ['opposite', 'alt', 'N', 'E', 'S', 'W']
const NEARS = ['entrance', 'stage', 'rear', 'rear-corner', 'side', 'center', 'exit', 'loading']

/** AIが返した方針を安全な値に整える */
export function sanitizeSpec(raw: any, b: Brief, idx: number): LayoutSpec {
  const d = defaultSpecs(b)[Math.min(idx, 2)]
  const num = (v: any, def: number, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : def)
  const str = (v: any, def: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : def)
  const r = raw || {}
  const seating = r.seating || {}
  const sideR = r.side || {}
  const booths = r.booths || {}
  return {
    key: String.fromCharCode(65 + idx),
    name: str(r.name, d.name).slice(0, 24),
    concept: str(r.concept, d.concept),
    rationale: Array.isArray(r.rationale) ? r.rationale.filter((x: any) => typeof x === 'string').slice(0, 5).map((x: string) => x.slice(0, 160)) : [],
    stageSide: b.stageSide !== 'auto' ? (b.stageSide as Side) : SIDES.includes(r.stageSide) ? r.stageSide : d.stageSide,
    stage: { on: typeof r.stage?.on === 'boolean' ? r.stage.on : d.stage.on, scale: num(r.stage?.scale, d.stage.scale, 0.5, 1.6) },
    seating: {
      style: STYLES.includes(seating.style) ? seating.style : d.seating.style,
      count: Math.round(num(seating.count, d.seating.count, 0, 20000)),
      centerAisle: typeof seating.centerAisle === 'boolean' ? seating.centerAisle : d.seating.centerAisle,
    },
    vip: Math.round(num(r.vip, d.vip, 0, 500)),
    side: {
      use: ['none', 'booths', 'lounge', 'fnb', 'mix'].includes(sideR.use) ? sideR.use : d.side.use,
      ratio: num(sideR.ratio, d.side.ratio, 0.15, 0.45),
      at: sideR.at === 'far' ? 'far' : sideR.at === 'entrance' ? 'entrance' : d.side.at,
    },
    booths: {
      count: Math.round(num(booths.count, d.booths.count, 0, 2000)),
      w: num(booths.w, b.boothW, 1500, 9000),
      d: num(booths.d, b.boothD, 1500, 9000),
      mode: ['wall', 'grid', 'perimeter', 'side'].includes(booths.mode) ? booths.mode : d.booths.mode,
      mainAisle: booths.mainAisle ? num(booths.mainAisle, 0, 0, 8000) : undefined,
    },
    reception: Math.round(num(r.reception, d.reception, 0, 40)),
    extras: Array.isArray(r.extras)
      ? r.extras
          .filter((e: any) => e && CATALOG[e.type as ObjType] && CATALOG[e.type as ObjType].layer !== 'structure' && e.type !== 'flow')
          .slice(0, 12)
          .map((e: any) => ({
            type: e.type as ObjType,
            label: typeof e.label === 'string' ? e.label.slice(0, 20) : undefined,
            count: Math.round(num(e.count, 1, 1, 30)),
            near: NEARS.includes(e.near) ? e.near : 'center',
            w: e.w ? num(e.w, 2000, 300, 30000) : undefined,
            h: e.h ? num(e.h, 2000, 100, 30000) : undefined,
          }))
      : [],
  }
}
