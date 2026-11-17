import { SEAT, seatProps } from './catalog'
import { localToWorld, objAABB, objGap, pointInPoly, rectsOverlap } from './geometry'
import type { Obj, Pt, Rect } from './types'

export interface SeatEnv {
  /** 席を間引く障害物（柱・固定設備・内壁・使用不可） */
  blockers: Obj[]
  outline: Pt[]
}

export interface BlockLayout {
  seats: Rect[]
  tables: Rect[]
}

/** 客席ブロックのローカル座標での席・机の並び（間引き前） */
export function blockLayout(o: Obj): BlockLayout {
  const p = seatProps(o)
  const rows = Math.max(1, Math.round(o.props?.rows || 1))
  const cols = Math.max(1, Math.round(o.props?.cols || 1))
  const px = o.w / cols
  const py = o.h / rows
  const seats: Rect[] = []
  const tables: Rect[] = []
  if (p.style === 'classroom') {
    const d = SEAT.classroom
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        tables.push({ x: j * px + 30, y: i * py, w: px - 60, h: d.tableD })
        for (let k = 0; k < d.perTable; k++) {
          seats.push({ x: j * px + ((k + 0.5) * px) / d.perTable - d.seatW / 2, y: i * py + d.tableD + 90, w: d.seatW, h: d.seatD })
        }
      }
    }
  } else {
    const sw = Math.min(p.seatW, px - 40)
    const sd = Math.min(p.seatD, py - 120)
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        seats.push({ x: j * px + (px - sw) / 2, y: i * py + (py - sd) - 60, w: sw, h: sd })
      }
    }
  }
  return { seats, tables }
}

const cache = new WeakMap<Obj, { b: Obj[]; o: Pt[]; res: BlockLayout }>()

/** 出入口の室内側に確保する空き（疑似オブジェクト） */
export function doorClearance(d: Obj, depth: number, extraW = 200): Obj {
  const r = ((d.rot || 0) * Math.PI) / 180
  const nx = -Math.sin(r)
  const ny = Math.cos(r)
  const cx = d.x + d.w / 2
  const cy = d.y + d.h / 2
  const w = d.w + extraW
  return { id: 'clr-' + d.id, type: 'zone', x: cx + nx * (depth / 2) - w / 2, y: cy + ny * (depth / 2) - depth / 2, w, h: depth, rot: d.rot || 0 }
}

const ISLAND = new Set(['foh', 'camera'])
const blockerCache: { s: Obj[]; isl: Obj[]; res: Obj[] }[] = []

/**
 * 席を間引く障害物：会場構造（柱・固定設備など）＋ 出入口の前 ＋ 客席の中に置く音響卓・カメラ台。
 * 入力が同じなら同じ配列を返す（描画キャッシュのキーに使うため）。
 */
export function seatBlockers(structure: Obj[], objects: Obj[] | null | undefined): Obj[] {
  const isl = objects ? objects.filter((o) => ISLAND.has(o.type) && !o.hidden) : []
  for (const c of blockerCache) {
    if (c.s === structure && c.isl.length === isl.length && c.isl.every((o, i) => o === isl[i])) return c.res
  }
  const res = structure.filter((s) => !s.hidden && s.type !== 'entrance')
  // 出入口の前は席を置かない（開口幅＋奥行き2m）
  for (const d of structure) {
    if (d.type !== 'entrance' || d.hidden) continue
    res.push(doorClearance(d, 2000))
  }
  res.push(...isl)
  blockerCache.unshift({ s: structure, isl, res })
  if (blockerCache.length > 12) blockerCache.pop()
  return res
}

/** 柱などと干渉する席を除いた実際の並び（オブジェクト単位でメモ化） */
export function visibleLayout(o: Obj, env: SeatEnv): BlockLayout {
  const hit = cache.get(o)
  if (hit && hit.b === env.blockers && hit.o === env.outline) return hit.res
  const base = blockLayout(o)
  const bb = objAABB(o, 200)
  const near = env.blockers.filter((b) => rectsOverlap(objAABB(b, 150), bb))
  // 会場の外にはみ出していないか（四隅で簡易判定）
  const cs = [localToWorld(o, 0, 0), localToWorld(o, o.w, 0), localToWorld(o, o.w, o.h), localToWorld(o, 0, o.h)]
  const allInside = env.outline.length < 3 || cs.every((c) => pointInPoly(c, env.outline))
  let res = base
  if (near.length || !allInside) {
    const keep = (r: Rect) => {
      const c = localToWorld(o, r.x + r.w / 2, r.y + r.h / 2)
      if (!allInside && !pointInPoly(c, env.outline)) return false
      const probe = { x: c.x - r.w / 2, y: c.y - r.h / 2, w: r.w, h: r.h, rot: o.rot }
      for (const b of near) if (objGap(probe as Obj, b) < 120) return false
      return true
    }
    res = { seats: base.seats.filter(keep), tables: base.tables.filter(keep) }
  }
  cache.set(o, { b: env.blockers, o: env.outline, res })
  return res
}

export function seatCount(o: Obj, env: SeatEnv): number {
  if (o.type === 'seat_block') return visibleLayout(o, env).seats.length
  if (o.type === 'round_table') return Math.max(0, Math.round(o.props?.seats ?? 10))
  if (o.type === 'table') return Math.max(0, Math.round(o.props?.seats ?? 0))
  return 0
}

export function standingCap(o: Obj): number {
  const area = (o.w * o.h) / 1e6
  if (o.type === 'standing') return Math.floor(area * (o.props?.density ?? 1.5))
  if (o.type === 'lounge') return Math.floor(area * (o.props?.density ?? 0.7))
  return 0
}

/** 円卓まわりの椅子位置（ローカル） */
export function roundSeats(o: Obj): { cx: number; cy: number; r: number }[] {
  const n = Math.max(0, Math.round(o.props?.seats ?? 10))
  const R = Math.min(o.w, o.h) / 2
  const tableR = Math.max(300, R - 500)
  const out: { cx: number; cy: number; r: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    out.push({ cx: o.w / 2 + Math.cos(a) * (tableR + 250), cy: o.h / 2 + Math.sin(a) * (tableR + 250), r: 200 })
  }
  return out
}
