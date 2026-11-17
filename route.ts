// 動線の自動ルーティング。什器を避け、通路の中央寄りを、曲がり角を少なく通る経路を求める。
import { isSolid } from './catalog'
import { G_BLOCK, G_INSIDE, autoCell, makeGrid, objCorners, ptsBBox, rasterObj, rasterPoly } from './geometry'
import { doorClearance } from './seats'
import type { Grid } from './geometry'
import type { FlowKind, Obj, Plan, Project, Pt } from './types'

export interface RouteMap {
  g: Grid
  /** 障害物からの距離（セル数, 上限つき）。0 は通行不可 */
  clear: Uint8Array
}

export function buildRouteMap(project: Project, objects: Obj[]): RouteMap {
  const outline = project.venue.outline
  const bb = ptsBBox(outline)
  const cell = autoCell(bb, 150)
  const g = makeGrid(bb, cell)
  rasterPoly(g, outline, G_INSIDE)
  const grow = Math.max(0, 280 - cell / 2)
  for (const o of objects) if (o.type === 'seat_block' && !o.hidden) rasterObj(g, o, G_BLOCK, grow)
  for (const d of project.structure) if (d.type === 'entrance' && !d.hidden) rasterPoly(g, objCorners(doorClearance(d, 2000)), G_BLOCK, true)
  for (const s of project.structure) if (isSolid(s) && !s.hidden) rasterObj(g, s, G_BLOCK, grow)
  for (const o of objects) if (isSolid(o) && !o.hidden && o.type !== 'podium' && o.type !== 'seat_block') rasterObj(g, o, G_BLOCK, grow)
  const n = g.nx * g.ny
  const clear = new Uint8Array(n)
  const pass = (i: number) => (g.data[i] & G_INSIDE) !== 0 && (g.data[i] & G_BLOCK) === 0
  // 障害物（と会場外）からの距離を多点BFSで求める
  const q = new Int32Array(n)
  let qh = 0
  let qt = 0
  const dist = new Int16Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    if (!pass(i)) {
      dist[i] = 0
      q[qt++] = i
    }
  }
  // 外周も障害物扱い
  for (let i = 0; i < g.nx; i++) for (const j of [0, g.ny - 1]) {
    const idx = j * g.nx + i
    if (dist[idx] < 0) { dist[idx] = 1; q[qt++] = idx }
  }
  for (let j = 0; j < g.ny; j++) for (const i of [0, g.nx - 1]) {
    const idx = j * g.nx + i
    if (dist[idx] < 0) { dist[idx] = 1; q[qt++] = idx }
  }
  while (qh < qt) {
    const c = q[qh++]
    const cx = c % g.nx
    const cy = (c - cx) / g.nx
    const d = dist[c] + 1
    if (d > 12) continue
    if (cx > 0 && dist[c - 1] < 0) { dist[c - 1] = d; q[qt++] = c - 1 }
    if (cx < g.nx - 1 && dist[c + 1] < 0) { dist[c + 1] = d; q[qt++] = c + 1 }
    if (cy > 0 && dist[c - g.nx] < 0) { dist[c - g.nx] = d; q[qt++] = c - g.nx }
    if (cy < g.ny - 1 && dist[c + g.nx] < 0) { dist[c + g.nx] = d; q[qt++] = c + g.nx }
  }
  for (let i = 0; i < n; i++) clear[i] = pass(i) ? Math.max(1, Math.min(13, dist[i] < 0 ? 13 : dist[i])) : 0
  return { g, clear }
}

function nearestPassable(m: RouteMap, p: Pt): number {
  const { g, clear } = m
  const ci = Math.max(0, Math.min(g.nx - 1, Math.floor((p.x - g.ox) / g.cell)))
  const cj = Math.max(0, Math.min(g.ny - 1, Math.floor((p.y - g.oy) / g.cell)))
  let best = -1
  let bd = Infinity
  const R = Math.ceil(6000 / g.cell)
  for (let r = 0; r <= R && best < 0; r++) {
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= g.ny) continue
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= g.nx) continue
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue
        const idx = j * g.nx + i
        if (!clear[idx]) continue
        const d = (i - ci) ** 2 + (j - cj) ** 2
        if (d < bd) { bd = d; best = idx }
      }
    }
  }
  return best
}

const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

/** from → to の経路（ワールド座標の折れ線）。見つからなければ null */
export function route(m: RouteMap, from: Pt, to: Pt): number[] | null {
  const { g, clear } = m
  const s = nearestPassable(m, from)
  const e = nearestPassable(m, to)
  if (s < 0 || e < 0) return null
  const n = g.nx * g.ny
  const cost = new Float64Array(n * 4).fill(Infinity)
  const prev = new Int32Array(n * 4).fill(-1)
  // 二分ヒープ
  const heap: number[] = []
  const hc: number[] = []
  const push = (st: number, c: number) => {
    let i = heap.length
    heap.push(st)
    hc.push(c)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hc[p] <= c) break
      heap[i] = heap[p]; hc[i] = hc[p]
      i = p
    }
    heap[i] = st; hc[i] = c
  }
  const pop = (): [number, number] => {
    const st = heap[0]
    const c = hc[0]
    const ls = heap.pop() as number
    const lc = hc.pop() as number
    if (heap.length) {
      let i = 0
      const len = heap.length
      for (;;) {
        let k = i * 2 + 1
        if (k >= len) break
        if (k + 1 < len && hc[k + 1] < hc[k]) k++
        if (hc[k] >= lc) break
        heap[i] = heap[k]; hc[i] = hc[k]
        i = k
      }
      heap[i] = ls; hc[i] = lc
    }
    return [st, c]
  }
  for (let d = 0; d < 4; d++) {
    cost[s * 4 + d] = 0
    push(s * 4 + d, 0)
  }
  const TURN = 9
  let endState = -1
  while (heap.length) {
    const [st, c] = pop()
    if (c > cost[st]) continue
    const idx = st >> 2
    const dir = st & 3
    if (idx === e) { endState = st; break }
    const cx = idx % g.nx
    const cy = (idx - cx) / g.nx
    for (let d = 0; d < 4; d++) {
      if (((d + 2) & 3) === dir && c > 0) continue
      const nx = cx + DX[d]
      const ny = cy + DY[d]
      if (nx < 0 || ny < 0 || nx >= g.nx || ny >= g.ny) continue
      const ni = ny * g.nx + nx
      const cl = clear[ni]
      if (!cl) continue
      // 壁や什器に近いほど割高にして、通路の中央を通す
      const nc = c + 1 + (d === dir ? 0 : TURN) + (cl < 5 ? (5 - cl) * 0.9 : 0)
      const ns = ni * 4 + d
      if (nc < cost[ns]) {
        cost[ns] = nc
        prev[ns] = st
        push(ns, nc)
      }
    }
  }
  if (endState < 0) return null
  const cells: number[] = []
  for (let st = endState; st >= 0; st = prev[st]) cells.push(st >> 2)
  cells.reverse()
  const P = (idx: number): Pt => {
    const cx = idx % g.nx
    return { x: g.ox + (cx + 0.5) * g.cell, y: g.oy + ((idx - cx) / g.nx + 0.5) * g.cell }
  }
  // 曲がり角だけ残す
  const pts: Pt[] = [P(cells[0])]
  for (let i = 1; i < cells.length - 1; i++) {
    const a = cells[i - 1]
    const b = cells[i]
    const c2 = cells[i + 1]
    if (b - a !== c2 - b) pts.push(P(b))
  }
  if (cells.length > 1) pts.push(P(cells[cells.length - 1]))
  // 端点を指定位置に合わせる（直交を保つ）
  const fit = (list: Pt[], target: Pt) => {
    if (list.length < 2) { list[0] = { ...target }; return }
    const a = list[0]
    const b = list[1]
    const horiz = Math.abs(b.y - a.y) < 1
    if (horiz) {
      list[0] = { x: target.x, y: target.y }
      list[1] = { x: b.x, y: target.y }
      if (list.length > 2 && Math.abs(list[2].x - b.x) > 1) list.splice(2, 0, { x: b.x, y: b.y })
    } else {
      list[0] = { x: target.x, y: target.y }
      list[1] = { x: target.x, y: b.y }
      if (list.length > 2 && Math.abs(list[2].y - b.y) > 1) list.splice(2, 0, { x: b.x, y: b.y })
    }
  }
  if (Math.hypot(pts[0].x - from.x, pts[0].y - from.y) < g.cell * 3) fit(pts, from)
  pts.reverse()
  if (Math.hypot(pts[0].x - to.x, pts[0].y - to.y) < g.cell * 3) fit(pts, to)
  pts.reverse()
  const out: number[] = []
  let last: Pt | null = null
  for (const p of pts) {
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 120) continue
    out.push(Math.round(p.x), Math.round(p.y))
    last = p
  }
  return out.length >= 4 ? out : null
}

export function flowObj(kind: FlowKind, pts: number[], id: string): Obj {
  const xs = pts.filter((_, i) => i % 2 === 0)
  const ys = pts.filter((_, i) => i % 2 === 1)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { id, type: 'flow', x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, rot: 0, props: { kind, pts } }
}

/** 既存の動線を、いまの配置に合わせて引き直す（始点と終点は保つ） */
export function rerouteFlows(project: Project, plan: Plan): Obj[] {
  const m = buildRouteMap(project, plan.objects)
  return plan.objects.map((o) => {
    if (o.type !== 'flow' || o.locked) return o
    const pts: number[] = o.props?.pts || []
    if (pts.length < 4) return o
    const a = { x: pts[0], y: pts[1] }
    const b = { x: pts[pts.length - 2], y: pts[pts.length - 1] }
    const r = route(m, a, b)
    if (!r) return o
    return { ...flowObj((o.props?.kind as FlowKind) || 'visitor', r, o.id), color: o.color, label: o.label }
  })
}
