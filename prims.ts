// 描画プリミティブ。キャンバス(Konva)・SVG・PPTX の3つの出力が同じプリミティブ列から描く。
import { norm360, rotPt } from './geometry'
import type { Obj } from './types'

interface Paint {
  fill?: string
  stroke?: string
  /** 線幅（そのプリミティブの座標系の単位） */
  sw?: number
  dash?: number[]
  op?: number
}
interface TextIn {
  text?: string
  ts?: number
  tc?: string
  tb?: boolean
}

export type RectPrim = { k: 'rect'; x: number; y: number; w: number; h: number; r?: number; rot?: number } & Paint & TextIn
export type EllipsePrim = { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number } & Paint & TextIn
export type PolyPrim = { k: 'poly'; pts: number[]; closed: boolean } & Paint
export type LinePrim = { k: 'line'; pts: number[]; stroke: string; sw: number; dash?: number[]; arrow?: boolean; op?: number }
export type TextPrim = {
  k: 'text'
  x: number
  y: number
  w: number
  h: number
  rot?: number
  text: string
  size: number
  color: string
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  op?: number
  /** 回転に沿わせる（壁沿いの文字など）。上下逆さまにだけはしない */
  along?: boolean
}
export type Prim = RectPrim | EllipsePrim | PolyPrim | LinePrim | TextPrim

/** 見た目の文字幅（全角=1, 半角≈0.6） */
export function visLen(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0
    if (c === 32) n += 0.32
    else if (c < 0x7f) n += /[A-Z0-9]/.test(ch) ? 0.66 : 0.56
    else n += 1
  }
  return n
}

/** ボックスに収まる文字サイズ。小さすぎるなら 0（表示しない） */
export function fitText(text: string, w: number, h: number, max: number, min: number): number {
  const lines = text.split('\n')
  const len = Math.max(0.5, ...lines.map(visLen))
  const size = Math.min(max, (h * 0.78) / (lines.length * 1.2), (w * 0.9) / len)
  return size < min ? 0 : size
}

/** オブジェクトのローカル座標のプリミティブをワールド座標へ。文字は必ず正立させる。 */
export function flatten(o: Obj, prims: Prim[]): Prim[] {
  const rot = norm360(o.rot || 0)
  if (!rot && !o.x && !o.y) return prims
  const cx = o.x + o.w / 2
  const cy = o.y + o.h / 2
  const P = (lx: number, ly: number) => rotPt(o.x + lx, o.y + ly, cx, cy, rot)
  const right = rot % 90 === 0
  const out: Prim[] = []
  for (const p of prims) {
    switch (p.k) {
      case 'rect': {
        const c = P(p.x + p.w / 2, p.y + p.h / 2)
        let w = p.w
        let h = p.h
        let r = norm360(rot + (p.rot || 0))
        if (r % 90 === 0) {
          if (r % 180 !== 0) [w, h] = [h, w]
          r = 0
        } else if (r > 90 && r < 270) r = norm360(r + 180)
        let ts = p.ts
        if (p.text && ts) ts = Math.min(ts, fitText(p.text, w, h, ts, 0) || ts)
        out.push({ ...p, x: c.x - w / 2, y: c.y - h / 2, w, h, rot: r, ts })
        break
      }
      case 'ellipse': {
        const c = P(p.cx, p.cy)
        const swap = right && rot % 180 !== 0
        out.push({ ...p, cx: c.x, cy: c.y, rx: swap ? p.ry : p.rx, ry: swap ? p.rx : p.ry })
        break
      }
      case 'poly':
      case 'line': {
        const pts: number[] = []
        for (let i = 0; i < p.pts.length; i += 2) {
          const q = P(p.pts[i], p.pts[i + 1])
          pts.push(q.x, q.y)
        }
        out.push({ ...p, pts })
        break
      }
      case 'text': {
        const c = P(p.x + p.w / 2, p.y + p.h / 2)
        let w = p.w
        let h = p.h
        let r = norm360(rot + (p.rot || 0))
        if (p.along) {
          if (r > 90 && r < 270) r = norm360(r + 180)
        } else if (r % 90 === 0) {
          // 正立させる（箱は文字が入るよう横長のまま中心だけ移す）
          r = 0
        } else if (r > 90 && r < 270) r = norm360(r + 180)
        if (w < h) [w, h] = [h, w]
        out.push({ ...p, x: c.x - w / 2, y: c.y - h / 2, w, h, rot: r })
        break
      }
    }
  }
  return out
}

/** 一様スケール＋平行移動（ワールド→シート）。線幅・文字サイズも一緒に変換する。 */
export function transformPrims(prims: Prim[], s: number, tx: number, ty: number): Prim[] {
  return prims.map((p): Prim => {
    switch (p.k) {
      case 'rect':
        return { ...p, x: p.x * s + tx, y: p.y * s + ty, w: p.w * s, h: p.h * s, r: p.r ? p.r * s : p.r, sw: p.sw ? p.sw * s : p.sw, dash: p.dash?.map((d) => d * s), ts: p.ts ? p.ts * s : p.ts }
      case 'ellipse':
        return { ...p, cx: p.cx * s + tx, cy: p.cy * s + ty, rx: p.rx * s, ry: p.ry * s, sw: p.sw ? p.sw * s : p.sw, dash: p.dash?.map((d) => d * s), ts: p.ts ? p.ts * s : p.ts }
      case 'poly':
        return { ...p, pts: p.pts.map((v, i) => (i % 2 ? v * s + ty : v * s + tx)), sw: p.sw ? p.sw * s : p.sw, dash: p.dash?.map((d) => d * s) }
      case 'line':
        return { ...p, pts: p.pts.map((v, i) => (i % 2 ? v * s + ty : v * s + tx)), sw: p.sw * s, dash: p.dash?.map((d) => d * s) }
      case 'text':
        return { ...p, x: p.x * s + tx, y: p.y * s + ty, w: p.w * s, h: p.h * s, size: p.size * s }
    }
  })
}

/** 矢印の頭（先端 tip、向き from→tip）の三角形と、線を止める位置 */
export function arrowHead(pts: number[], sw: number): { tri: number[]; cut: [number, number] } | null {
  const n = pts.length
  if (n < 4) return null
  const tx = pts[n - 2]
  const ty = pts[n - 1]
  let fx = pts[n - 4]
  let fy = pts[n - 3]
  let k = n - 4
  while (Math.hypot(tx - fx, ty - fy) < 1e-6 && k >= 2) {
    k -= 2
    fx = pts[k]
    fy = pts[k + 1]
  }
  const l = Math.hypot(tx - fx, ty - fy)
  if (l < 1e-6) return null
  const ux = (tx - fx) / l
  const uy = (ty - fy) / l
  const len = Math.min(sw * 4.2, l * 0.9)
  const half = sw * 1.9
  const bx = tx - ux * len
  const by = ty - uy * len
  return { tri: [tx, ty, bx - uy * half, by + ux * half, bx + uy * half, by - ux * half], cut: [bx + ux * len * 0.15, by + uy * len * 0.15] }
}

// ───────────────────────── Canvas 2D ─────────────────────────

export const FONT_STACK = `'IBM Plex Sans JP','Yu Gothic','YuGothic','Hiragino Sans','Noto Sans JP','Noto Sans CJK JP',Meiryo,sans-serif`

let ALPHA = 1

function paint(ctx: CanvasRenderingContext2D, p: { fill?: string; stroke?: string; sw?: number; dash?: number[]; op?: number }) {
  const op = (p.op ?? 1) * ALPHA
  if (p.fill) {
    ctx.globalAlpha = op
    ctx.fillStyle = p.fill
    ctx.fill()
  }
  if (p.stroke && p.sw) {
    ctx.globalAlpha = p.fill ? Math.min(ALPHA, op + 0.5 * ALPHA) : op
    ctx.strokeStyle = p.stroke
    ctx.lineWidth = p.sw
    ctx.setLineDash(p.dash || [])
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.globalAlpha = ALPHA
}

function drawText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, size: number, color: string, bold: boolean, align: 'left' | 'center' | 'right', boxW: number) {
  if (!text || size <= 0) return
  const lines = text.split('\n')
  ctx.font = `${bold ? '600 ' : '400 '}${size}px ${FONT_STACK}`
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.textAlign = align
  const lh = size * 1.2
  const x = align === 'left' ? cx - boxW / 2 : align === 'right' ? cx + boxW / 2 : cx
  lines.forEach((ln, i) => ctx.fillText(ln, x, cy + (i - (lines.length - 1) / 2) * lh))
}

/**
 * プリミティブを Canvas 2D に描く。objRot はその座標系がすでに何度回っているか（文字を正立させるために使う）。
 */
export function drawPrims(ctx: CanvasRenderingContext2D, prims: Prim[], objRot = 0, alpha = 1) {
  const base = norm360(objRot)
  ALPHA = alpha
  ctx.globalAlpha = alpha
  for (const p of prims) {
    switch (p.k) {
      case 'rect': {
        ctx.save()
        if (p.rot) {
          ctx.translate(p.x + p.w / 2, p.y + p.h / 2)
          ctx.rotate((p.rot * Math.PI) / 180)
          ctx.translate(-(p.x + p.w / 2), -(p.y + p.h / 2))
        }
        ctx.beginPath()
        if (p.r) ctx.roundRect(p.x, p.y, p.w, p.h, Math.min(p.r, p.w / 2, p.h / 2))
        else ctx.rect(p.x, p.y, p.w, p.h)
        paint(ctx, p)
        ctx.restore()
        if (p.text && p.ts) {
          const total = norm360(base + (p.rot || 0))
          let w = p.w
          let h = p.h
          let back = 0
          if (total % 90 === 0) {
            back = -total
            if (total % 180 !== 0) [w, h] = [h, w]
          } else if (total > 90 && total < 270) back = 180
          const ts = Math.min(p.ts, fitText(p.text, w, h, p.ts, 0) || p.ts)
          ctx.save()
          ctx.translate(p.x + p.w / 2, p.y + p.h / 2)
          ctx.rotate((((p.rot || 0) + back) * Math.PI) / 180)
          drawText(ctx, p.text, 0, 0, ts, p.tc || '#000', !!p.tb, 'center', w)
          ctx.restore()
        }
        break
      }
      case 'ellipse': {
        ctx.beginPath()
        ctx.ellipse(p.cx, p.cy, p.rx, p.ry, 0, 0, Math.PI * 2)
        paint(ctx, p)
        if (p.text && p.ts) {
          ctx.save()
          ctx.translate(p.cx, p.cy)
          ctx.rotate((-base * Math.PI) / 180)
          drawText(ctx, p.text, 0, 0, p.ts, p.tc || '#000', !!p.tb, 'center', p.rx * 2)
          ctx.restore()
        }
        break
      }
      case 'poly': {
        if (p.pts.length < 4) break
        ctx.beginPath()
        ctx.moveTo(p.pts[0], p.pts[1])
        for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(p.pts[i], p.pts[i + 1])
        if (p.closed) ctx.closePath()
        ctx.lineJoin = 'miter'
        paint(ctx, p)
        break
      }
      case 'line': {
        if (p.pts.length < 4) break
        const head = p.arrow ? arrowHead(p.pts, p.sw) : null
        ctx.globalAlpha = (p.op ?? 1) * ALPHA
        ctx.beginPath()
        ctx.moveTo(p.pts[0], p.pts[1])
        const n = p.pts.length
        for (let i = 2; i < n - 2; i += 2) ctx.lineTo(p.pts[i], p.pts[i + 1])
        if (head) ctx.lineTo(head.cut[0], head.cut[1])
        else ctx.lineTo(p.pts[n - 2], p.pts[n - 1])
        ctx.strokeStyle = p.stroke
        ctx.lineWidth = p.sw
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.setLineDash(p.dash || [])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineCap = 'butt'
        if (head) {
          ctx.beginPath()
          ctx.moveTo(head.tri[0], head.tri[1])
          ctx.lineTo(head.tri[2], head.tri[3])
          ctx.lineTo(head.tri[4], head.tri[5])
          ctx.closePath()
          ctx.fillStyle = p.stroke
          ctx.fill()
        }
        ctx.globalAlpha = ALPHA
        break
      }
      case 'text': {
        const total = norm360(base + (p.rot || 0))
        let back = 0
        if (p.along) back = total > 90 && total < 270 ? 180 : 0
        else if (total % 90 === 0) back = -total
        else if (total > 90 && total < 270) back = 180
        const w = Math.max(p.w, p.h)
        ctx.save()
        ctx.globalAlpha = (p.op ?? 1) * ALPHA
        ctx.translate(p.x + p.w / 2, p.y + p.h / 2)
        ctx.rotate((((p.rot || 0) + back) * Math.PI) / 180)
        drawText(ctx, p.text, 0, 0, p.size, p.color, !!p.bold, p.align || 'center', w)
        ctx.restore()
        break
      }
    }
  }
  ALPHA = 1
  ctx.globalAlpha = 1
}

// ───────────────────────── SVG ─────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(3)).replace(/\.?0+$/, '')

function svgPaint(p: { fill?: string; stroke?: string; sw?: number; dash?: number[]; op?: number }): string {
  let s = ` fill="${p.fill || 'none'}"`
  if (p.fill && p.op !== undefined && p.op < 1) s += ` fill-opacity="${f(p.op)}"`
  if (p.stroke && p.sw) {
    s += ` stroke="${p.stroke}" stroke-width="${f(p.sw)}"`
    if (p.dash?.length) s += ` stroke-dasharray="${p.dash.map(f).join(' ')}"`
    if (!p.fill && p.op !== undefined && p.op < 1) s += ` stroke-opacity="${f(p.op)}"`
  }
  return s
}

function svgText(text: string, cx: number, cy: number, size: number, color: string, bold: boolean, align: 'left' | 'center' | 'right', boxW: number, rot: number, op?: number): string {
  if (!text || size <= 0) return ''
  const lines = text.split('\n')
  const lh = size * 1.2
  const x = align === 'left' ? cx - boxW / 2 : align === 'right' ? cx + boxW / 2 : cx
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'
  const tr = rot ? ` transform="rotate(${f(rot)} ${f(cx)} ${f(cy)})"` : ''
  const o = op !== undefined && op < 1 ? ` opacity="${f(op)}"` : ''
  let s = `<text font-size="${f(size)}" fill="${color}" text-anchor="${anchor}"${bold ? ' font-weight="600"' : ''}${tr}${o}>`
  lines.forEach((ln, i) => {
    s += `<tspan x="${f(x)}" y="${f(cy + (i - (lines.length - 1) / 2) * lh + size * 0.36)}">${esc(ln)}</tspan>`
  })
  return s + '</text>'
}

/** ワールド（またはシート）座標のプリミティブ列を SVG 要素文字列にする */
export function primsToSvg(prims: Prim[]): string {
  let s = ''
  for (const p of prims) {
    switch (p.k) {
      case 'rect': {
        const tr = p.rot ? ` transform="rotate(${f(p.rot)} ${f(p.x + p.w / 2)} ${f(p.y + p.h / 2)})"` : ''
        s += `<rect x="${f(p.x)}" y="${f(p.y)}" width="${f(p.w)}" height="${f(p.h)}"${p.r ? ` rx="${f(Math.min(p.r, p.w / 2, p.h / 2))}"` : ''}${svgPaint(p)}${tr}/>`
        if (p.text && p.ts) s += svgText(p.text, p.x + p.w / 2, p.y + p.h / 2, p.ts, p.tc || '#000', !!p.tb, 'center', p.w, p.rot || 0)
        break
      }
      case 'ellipse':
        s += `<ellipse cx="${f(p.cx)}" cy="${f(p.cy)}" rx="${f(p.rx)}" ry="${f(p.ry)}"${svgPaint(p)}/>`
        if (p.text && p.ts) s += svgText(p.text, p.cx, p.cy, p.ts, p.tc || '#000', !!p.tb, 'center', p.rx * 2, 0)
        break
      case 'poly': {
        const pts: string[] = []
        for (let i = 0; i < p.pts.length; i += 2) pts.push(`${f(p.pts[i])},${f(p.pts[i + 1])}`)
        s += `<${p.closed ? 'polygon' : 'polyline'} points="${pts.join(' ')}"${svgPaint(p)} stroke-linejoin="miter"/>`
        break
      }
      case 'line': {
        const head = p.arrow ? arrowHead(p.pts, p.sw) : null
        const n = p.pts.length
        const pts: string[] = []
        for (let i = 0; i < n - 2; i += 2) pts.push(`${f(p.pts[i])},${f(p.pts[i + 1])}`)
        pts.push(head ? `${f(head.cut[0])},${f(head.cut[1])}` : `${f(p.pts[n - 2])},${f(p.pts[n - 1])}`)
        const o = p.op !== undefined && p.op < 1 ? ` opacity="${f(p.op)}"` : ''
        s += `<g${o}><polyline points="${pts.join(' ')}" fill="none" stroke="${p.stroke}" stroke-width="${f(p.sw)}" stroke-linejoin="round" stroke-linecap="round"${p.dash?.length ? ` stroke-dasharray="${p.dash.map(f).join(' ')}"` : ''}/>`
        if (head) s += `<polygon points="${f(head.tri[0])},${f(head.tri[1])} ${f(head.tri[2])},${f(head.tri[3])} ${f(head.tri[4])},${f(head.tri[5])}" fill="${p.stroke}"/>`
        s += '</g>'
        break
      }
      case 'text':
        s += svgText(p.text, p.x + p.w / 2, p.y + p.h / 2, p.size, p.color, !!p.bold, p.align || 'center', p.w, p.rot || 0, p.op)
        break
    }
  }
  return s
}
