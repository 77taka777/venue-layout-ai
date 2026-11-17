import type { Obj, Pt, Rect } from './types'

export const rad = (d: number) => (d * Math.PI) / 180
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const snap = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v)
export const snapDown = (v: number, step: number) => Math.floor(v / step + 1e-9) * step
export const norm360 = (d: number) => ((d % 360) + 360) % 360

/** (px,py) を (cx,cy) 中心に時計回り deg 度回す（y下向き座標系） */
export function rotPt(px: number, py: number, cx: number, cy: number, deg: number): Pt {
  if (!deg) return { x: px, y: py }
  const r = rad(deg)
  const c = Math.cos(r)
  const s = Math.sin(r)
  const dx = px - cx
  const dy = py - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}

export const objCenter = (o: Rect): Pt => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 })

/** ローカル座標(オブジェクト左上原点)をワールドへ */
export function localToWorld(o: Obj, lx: number, ly: number): Pt {
  return rotPt(o.x + lx, o.y + ly, o.x + o.w / 2, o.y + o.h / 2, o.rot)
}

export function objCorners(o: { x: number; y: number; w: number; h: number; rot?: number }, grow = 0): Pt[] {
  const cx = o.x + o.w / 2
  const cy = o.y + o.h / 2
  const x0 = o.x - grow
  const y0 = o.y - grow
  const x1 = o.x + o.w + grow
  const y1 = o.y + o.h + grow
  const rot = o.rot || 0
  return [rotPt(x0, y0, cx, cy, rot), rotPt(x1, y0, cx, cy, rot), rotPt(x1, y1, cx, cy, rot), rotPt(x0, y1, cx, cy, rot)]
}

export function ptsBBox(pts: Pt[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export const objAABB = (o: { x: number; y: number; w: number; h: number; rot?: number }, grow = 0): Rect =>
  ptsBBox(objCorners(o, grow))

export function rectsOverlap(a: Rect, b: Rect, eps = 0): boolean {
  return a.x < b.x + b.w - eps && a.x + a.w > b.x + eps && a.y < b.y + b.h - eps && a.y + a.h > b.y + eps
}

export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function polyArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  return Math.abs(s / 2)
}

/** 符号付き面積。y下向きで正なら時計回り */
export function polySigned(poly: Pt[]): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x - poly[i].x) * (poly[j].y + poly[i].y)
  return s / 2
}

export function distPtSeg(p: Pt, a: Pt, b: Pt): { d: number; t: number; q: Pt } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
  t = clamp(t, 0, 1)
  const q = { x: a.x + t * dx, y: a.y + t * dy }
  return { d: Math.hypot(p.x - q.x, p.y - q.y), t, q }
}

export function nearestEdge(p: Pt, poly: Pt[]): { i: number; d: number; t: number; q: Pt; angle: number; len: number } {
  let best = { i: 0, d: Infinity, t: 0, q: p, angle: 0, len: 0 }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const r = distPtSeg(p, a, b)
    if (r.d < best.d) {
      best = { i, d: r.d, t: r.t, q: r.q, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, len: Math.hypot(b.x - a.x, b.y - a.y) }
    }
  }
  return best
}

function project(poly: Pt[], ax: number, ay: number): [number, number] {
  let mn = Infinity
  let mx = -Infinity
  for (const p of poly) {
    const v = p.x * ax + p.y * ay
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  return [mn, mx]
}

/**
 * 凸多角形どうしの分離距離（SAT）。
 * 正: 離れている（その距離以上）, 負: めり込み量。
 */
export function convexGap(A: Pt[], B: Pt[]): number {
  let best = -Infinity
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      let nx = b.y - a.y
      let ny = -(b.x - a.x)
      const l = Math.hypot(nx, ny)
      if (!l) continue
      nx /= l
      ny /= l
      const [a0, a1] = project(A, nx, ny)
      const [b0, b1] = project(B, nx, ny)
      const sep = Math.max(b0 - a1, a0 - b1)
      if (sep > best) best = sep
    }
  }
  return best
}

export function objGap(a: Obj | Rect, b: Obj | Rect): number {
  const ra = (a as Obj).rot || 0
  const rb = (b as Obj).rot || 0
  if (ra % 90 === 0 && rb % 90 === 0) {
    const A = objAABB(a as Obj)
    const B = objAABB(b as Obj)
    const dx = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w))
    const dy = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h))
    if (dx > 0 && dy > 0) return Math.hypot(dx, dy)
    return Math.max(dx, dy)
  }
  return convexGap(objCorners(a as Obj), objCorners(b as Obj))
}

/** 重なり判定（tol mm までの接触は許容） */
export function objsOverlap(a: Obj | Rect, b: Obj | Rect, tol = 1): boolean {
  return objGap(a, b) < -tol
}

/** オブジェクトが多角形の内側に収まっているか（tol mm のはみ出しは許容） */
export function objInsidePoly(o: Obj | Rect, poly: Pt[], tol = 30): boolean {
  const cs = objCorners(o as Obj, -tol)
  const c = objCenter(o)
  if (!pointInPoly(c, poly)) return false
  for (const p of cs) if (!pointInPoly(p, poly)) return false
  // 辺の中点も確認（凹型の会場対策）
  for (let i = 0; i < 4; i++) {
    const a = cs[i]
    const b = cs[(i + 1) % 4]
    if (!pointInPoly({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, poly)) return false
  }
  return true
}

export function isAxisRect(poly: Pt[], tol = 5): Rect | null {
  if (poly.length !== 4) return null
  const bb = ptsBBox(poly)
  for (const p of poly) {
    const onX = Math.abs(p.x - bb.x) < tol || Math.abs(p.x - (bb.x + bb.w)) < tol
    const onY = Math.abs(p.y - bb.y) < tol || Math.abs(p.y - (bb.y + bb.h)) < tol
    if (!onX || !onY) return null
  }
  return bb
}

// ───────────────────────── グリッド ─────────────────────────

export interface Grid {
  cell: number
  ox: number
  oy: number
  nx: number
  ny: number
  data: Uint8Array
}

export const G_INSIDE = 1
export const G_BLOCK = 2

export function makeGrid(bb: Rect, cell: number): Grid {
  const nx = Math.max(1, Math.ceil(bb.w / cell))
  const ny = Math.max(1, Math.ceil(bb.h / cell))
  return { cell, ox: bb.x, oy: bb.y, nx, ny, data: new Uint8Array(nx * ny) }
}

export function autoCell(bb: Rect, target = 220): number {
  return Math.max(100, Math.ceil(Math.max(bb.w, bb.h) / target / 50) * 50)
}

/** セル中心が多角形内のセルに flag を立てる（スキャンライン） */
export function rasterPoly(g: Grid, poly: Pt[], flag: number, clear = false) {
  for (let j = 0; j < g.ny; j++) {
    const y = g.oy + (j + 0.5) * g.cell
    const xs: number[] = []
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const a = poly[i]
      const b = poly[k]
      if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
    }
    xs.sort((p, q) => p - q)
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - g.ox) / g.cell - 0.5))
      const i1 = Math.min(g.nx - 1, Math.floor((xs[s + 1] - g.ox) / g.cell - 0.5))
      for (let i = i0; i <= i1; i++) {
        if (clear) g.data[j * g.nx + i] &= ~flag
        else g.data[j * g.nx + i] |= flag
      }
    }
  }
}

export function rasterObj(g: Grid, o: Obj | Rect, flag: number, grow = 0) {
  rasterPoly(g, objCorners(o as Obj, grow), flag)
}

/** pred を満たすセルだけでできる最大の軸平行長方形（mm） */
export function largestRect(g: Grid, pred: (v: number) => boolean): Rect | null {
  const h = new Int32Array(g.nx)
  let best = 0
  let br: Rect | null = null
  const stack: number[] = []
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) h[i] = pred(g.data[j * g.nx + i]) ? h[i] + 1 : 0
    stack.length = 0
    for (let i = 0; i <= g.nx; i++) {
      const cur = i === g.nx ? 0 : h[i]
      while (stack.length && h[stack[stack.length - 1]] >= cur) {
        const top = stack.pop() as number
        const height = h[top]
        const left = stack.length ? stack[stack.length - 1] + 1 : 0
        const width = i - left
        const area = height * width
        if (area > best) {
          best = area
          br = { x: g.ox + left * g.cell, y: g.oy + (j - height + 1) * g.cell, w: width * g.cell, h: height * g.cell }
        }
      }
      stack.push(i)
    }
  }
  return br
}

/** src セルからの4近傍BFS距離（セル数）。通れないセルは -1 */
export function bfs(g: Grid, passable: (idx: number) => boolean, src: number[]): Int32Array {
  const dist = new Int32Array(g.nx * g.ny).fill(-1)
  const q = new Int32Array(g.nx * g.ny)
  let qh = 0
  let qt = 0
  for (const s of src) {
    if (s >= 0 && s < dist.length && passable(s) && dist[s] < 0) {
      dist[s] = 0
      q[qt++] = s
    }
  }
  while (qh < qt) {
    const c = q[qh++]
    const cx = c % g.nx
    const cy = (c - cx) / g.nx
    const d = dist[c] + 1
    if (cx > 0) {
      const n = c - 1
      if (dist[n] < 0 && passable(n)) { dist[n] = d; q[qt++] = n }
    }
    if (cx < g.nx - 1) {
      const n = c + 1
      if (dist[n] < 0 && passable(n)) { dist[n] = d; q[qt++] = n }
    }
    if (cy > 0) {
      const n = c - g.nx
      if (dist[n] < 0 && passable(n)) { dist[n] = d; q[qt++] = n }
    }
    if (cy < g.ny - 1) {
      const n = c + g.nx
      if (dist[n] < 0 && passable(n)) { dist[n] = d; q[qt++] = n }
    }
  }
  return dist
}

export function cellAt(g: Grid, x: number, y: number): number {
  const i = clamp(Math.floor((x - g.ox) / g.cell), 0, g.nx - 1)
  const j = clamp(Math.floor((y - g.oy) / g.cell), 0, g.ny - 1)
  return j * g.nx + i
}

// ───────────────────────── 輪郭の整形 ─────────────────────────

/** ほぼ水平・垂直な辺を直角に揃える */
export function orthogonalize(poly: Pt[], tolDeg = 7): Pt[] {
  const pts = poly.map((p) => ({ ...p }))
  const n = pts.length
  const t = Math.tan(rad(tolDeg))
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const dx = Math.abs(b.x - a.x)
      const dy = Math.abs(b.y - a.y)
      if (dy <= dx * t) {
        const y = (a.y + b.y) / 2
        a.y = y
        b.y = y
      } else if (dx <= dy * t) {
        const x = (a.x + b.x) / 2
        a.x = x
        b.x = x
      }
    }
  }
  return pts
}

/** 重複点・一直線上の点を除き、時計回りに正規化 */
export function cleanPoly(poly: Pt[], minSeg = 100): Pt[] {
  let pts = poly.filter((p) => isFinite(p.x) && isFinite(p.y))
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) >= minSeg) out.push(p)
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < minSeg) out.pop()
  pts = out
  // 一直線上の中間点を削除
  const res: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length]
    const b = pts[i]
    const c = pts[(i + 1) % pts.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    const scale = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y)
    if (scale && Math.abs(cross) / scale > 0.02) res.push(b)
  }
  if (res.length >= 3) pts = res
  if (polySigned(pts) < 0) pts.reverse()
  return pts
}

export function rectPoly(r: Rect): Pt[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
}
