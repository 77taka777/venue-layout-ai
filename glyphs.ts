// オブジェクト種別ごとの「描き方」。ローカル座標（左上原点・回転前）のプリミティブを返す。
import { CATALOG, ENTRANCE_LABEL, cat, objName } from './catalog'
import { ptsBBox } from './geometry'
import { fitText } from './prims'
import type { Prim } from './prims'
import { roundSeats, seatCount, standingCap, visibleLayout } from './seats'
import type { SeatEnv } from './seats'
import type { Theme } from './themes'
import type { EntranceKind, FlowKind, Obj, Pt, Venue } from './types'

export interface GlyphEnv extends SeatEnv {
  theme: Theme
  /** 図面全体の線幅・文字サイズ倍率（会場規模に合わせる） */
  ss: number
  wallT: number
  /** 客席を1席ずつ描くか（false ならブロック＋席数） */
  seatDetail: boolean
  /** ラベル文字の倍率 */
  labelScale: number
}

export function styleScale(outline: Pt[]): number {
  const bb = ptsBBox(outline)
  const d = Math.hypot(bb.w, bb.h)
  return Math.max(0.7, Math.min(5, d / 36000))
}

const cache = new WeakMap<Obj, { env: GlyphEnv; prims: Prim[] }>()

export function glyph(o: Obj, env: GlyphEnv): Prim[] {
  const hit = cache.get(o)
  if (hit && hit.env === env) return hit.prims
  const prims = build(o, env)
  cache.set(o, { env, prims })
  return prims
}

function build(o: Obj, env: GlyphEnv): Prim[] {
  const { theme: t, ss } = env
  const c = t.cat[cat(o).cat]
  const fill = o.color || c.fill
  const thin = 28 * ss
  const mid = 45 * ss
  const { w, h } = o
  const name = objName(o)
  const L = env.labelScale
  const lab = (text: string, max = 520, min = 150) => fitText(text, w, h, max * ss * L, min * ss)
  const box = (text: string, extra: Partial<Prim> = {}): Prim =>
    ({ k: 'rect', x: 0, y: 0, w, h, fill, stroke: c.stroke, sw: thin, text, ts: lab(text), tc: c.ink, tb: true, ...extra }) as Prim

  switch (o.type) {
    case 'stage':
      return [{ k: 'rect', x: 0, y: 0, w, h, fill, stroke: c.stroke, sw: mid, text: o.label || 'STAGE', ts: lab(o.label || 'STAGE', 900), tc: c.ink, tb: true }]
    case 'screen': {
      const out: Prim[] = [{ k: 'rect', x: 0, y: 0, w, h, fill: o.color || t.ink }]
      return out
    }
    case 'podium':
      return [{ k: 'rect', x: 0, y: 0, w, h, r: 60, fill: o.color || t.tableTop, stroke: t.sub, sw: thin, text: o.label || '演台', ts: fitText(o.label || '演台', w, h, 260 * ss * L, 110 * ss), tc: t.ink }]
    case 'foh':
      return [box(o.label || 'PA')]
    case 'camera':
      return [box(o.label || 'CAM')]

    case 'seat_block': {
      const chair = o.color || (o.props?.style === 'vip' ? t.cat.exhibit.stroke : t.chair)
      if (!env.seatDetail) {
        const n = seatCount(o, env)
        const text = `${n}席`
        return [{ k: 'rect', x: 0, y: 0, w, h, r: 80, fill: chair, op: 0.55, stroke: c.stroke, sw: thin, text, ts: fitText(text, w, h, 700 * ss * L, 150 * ss), tc: t.ink, tb: true }]
      }
      const lay = visibleLayout(o, env)
      const out: Prim[] = []
      for (const tb of lay.tables) out.push({ k: 'rect', x: tb.x, y: tb.y, w: tb.w, h: tb.h, fill: t.tableTop, stroke: c.stroke, sw: thin })
      for (const s of lay.seats) out.push({ k: 'rect', x: s.x, y: s.y, w: s.w, h: s.h, r: 80, fill: chair })
      return out
    }
    case 'round_table': {
      const R = Math.min(w, h) / 2
      const tableR = Math.max(300, R - 500)
      const out: Prim[] = []
      for (const s of roundSeats(o)) out.push({ k: 'ellipse', cx: s.cx, cy: s.cy, rx: s.r, ry: s.r, fill: o.color || t.chair })
      const text = o.label || ''
      out.push({ k: 'ellipse', cx: w / 2, cy: h / 2, rx: tableR, ry: tableR, fill: t.tableTop, stroke: c.stroke, sw: thin, text, ts: text ? fitText(text, tableR * 1.6, tableR * 1.2, 380 * ss * L, 120 * ss) : 0, tc: t.ink })
      return out
    }
    case 'table': {
      const n = Math.max(0, Math.round(o.props?.seats || 0))
      const out: Prim[] = []
      const pad = n > 0 ? Math.min(480, h * 0.3) : 0
      if (n > 0) {
        const per = Math.ceil(n / 2)
        for (let i = 0; i < n; i++) {
          const top = i < per
          const k = top ? i : i - per
          const cnt = top ? per : n - per
          out.push({ k: 'ellipse', cx: ((k + 0.5) * w) / cnt, cy: top ? pad * 0.5 : h - pad * 0.5, rx: Math.min(200, pad * 0.42), ry: Math.min(200, pad * 0.42), fill: o.color || t.chair })
        }
      }
      const text = o.label || ''
      out.push({ k: 'rect', x: 0, y: pad, w, h: h - pad * 2, fill: t.tableTop, stroke: c.stroke, sw: thin, text, ts: text ? fitText(text, w, h - pad * 2, 320 * ss * L, 110 * ss) : 0, tc: t.ink })
      return out
    }
    case 'standing': {
      const text = `${o.label || 'スタンディング'}\n約${standingCap(o)}人`
      return [{ k: 'rect', x: 0, y: 0, w, h, r: 150, fill: o.color || c.fill, op: 0.45, stroke: c.stroke, sw: mid, dash: [260 * ss, 180 * ss], text, ts: fitText(text, w, h, 620 * ss * L, 160 * ss), tc: c.ink, tb: true }]
    }

    case 'booth': {
      const no = o.props?.no
      const text = o.label ? (no ? `${no}\n${o.label}` : o.label) : no ? String(no) : ''
      const wall = 110 * ss
      return [
        { k: 'rect', x: 0, y: 0, w, h, fill, stroke: c.stroke, sw: thin, text, ts: text ? fitText(text, w, h, 520 * ss * L, 140 * ss) : 0, tc: c.ink, tb: true },
        // 背面と袖のパネル（開口はローカル下側）
        { k: 'line', pts: [0, h * 0.72, 0, wall / 2, w, wall / 2, w, h * 0.72], stroke: c.stroke, sw: wall },
      ]
    }
    case 'reception': {
      const deskD = Math.min(620, h * 0.6)
      const out: Prim[] = []
      const cy = (h - deskD) / 2
      const r = Math.min(190, cy * 0.8)
      for (const fx of [0.28, 0.72]) out.push({ k: 'ellipse', cx: w * fx, cy, rx: r, ry: r, fill: t.chair })
      out.push({ k: 'rect', x: 0, y: h - deskD, w, h: deskD, r: 40, fill, stroke: c.stroke, sw: thin, text: o.label || '受付', ts: fitText(o.label || '受付', w, deskD, 340 * ss * L, 120 * ss), tc: c.ink, tb: true })
      return out
    }
    case 'cloak':
      return [box(o.label || 'クローク')]
    case 'lounge': {
      const out: Prim[] = [{ k: 'rect', x: 0, y: 0, w, h, r: 200, fill, op: 0.28, stroke: c.stroke, sw: thin, dash: [200 * ss, 140 * ss] }]
      const pitch = 2300
      const nx = Math.max(1, Math.floor((w - 800) / pitch) + 1)
      const ny = Math.max(1, Math.floor((h - 1500) / pitch) + 1)
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++) {
          const cx = nx === 1 ? w / 2 : 400 + ((w - 800) * i) / (nx - 1)
          const cy = ny === 1 ? h / 2 + 250 : 1100 + ((h - 1500) * j) / (ny - 1)
          out.push({ k: 'ellipse', cx, cy, rx: 330, ry: 330, fill: t.tableTop, stroke: c.stroke, sw: thin })
        }
      const text = o.label || '交流ラウンジ'
      out.push({ k: 'text', x: 200, y: 120, w: w - 400, h: 520 * ss, text, size: Math.min(380 * ss * L, fitText(text, w - 400, 600 * ss, 380 * ss * L, 0) || 380 * ss), color: c.ink, bold: true, align: 'left' })
      return out
    }
    case 'queue': {
      const out: Prim[] = [{ k: 'rect', x: 0, y: 0, w, h, r: 100, stroke: t.sub, sw: thin, dash: [160 * ss, 120 * ss] }]
      const rows = Math.max(1, Math.floor(h / 700))
      const pts: number[] = []
      for (let i = 0; i < rows; i++) {
        const y = ((i + 0.5) * h) / rows
        if (i % 2 === 0) pts.push(300, y, w - 300, y)
        else pts.push(w - 300, y, 300, y)
      }
      if (pts.length >= 4) out.push({ k: 'line', pts, stroke: t.sub, sw: 50 * ss, dash: [220 * ss, 160 * ss], arrow: true })
      const text = o.label || '待機列'
      out.push({ k: 'text', x: 0, y: -460 * ss, w, h: 400 * ss, text, size: 280 * ss * L, color: t.sub })
      return out
    }
    case 'food':
    case 'merch':
    case 'firstaid':
    case 'generic':
      return [box(name)]
    case 'staff':
    case 'backstage':
      return [box(name, { dash: [180 * ss, 120 * ss] })]
    case 'partition':
      return [{ k: 'rect', x: 0, y: 0, w, h, fill: o.color || t.ink }]
    case 'barricade':
      return [{ k: 'rect', x: 0, y: 0, w, h, fill: o.color || c.stroke }]
    case 'label': {
      const text = o.label || 'テキスト'
      return [{ k: 'text', x: 0, y: 0, w, h, text, size: fitText(text, w, h, 2000 * ss, 0), color: o.color || t.ink, bold: true }]
    }
    case 'zone': {
      const zc = o.props?.zcat ? t.cat[o.props.zcat as keyof typeof t.cat] : null
      const col = o.color || (zc ? zc.stroke : c.fill)
      const text = o.label || 'ゾーン'
      const size = Math.min(460 * ss * L, fitText(text, w - 400, Math.min(h, 900 * ss), 460 * ss * L, 0) || 300 * ss)
      return [
        { k: 'rect', x: 0, y: 0, w, h, r: 120, fill: col, op: 0.13, stroke: col, sw: mid, dash: [300 * ss, 200 * ss] },
        { k: 'text', x: 220, y: 160, w: Math.max(100, w - 440), h: size * 1.3, text, size, color: o.color || (zc ? (t.dark ? zc.stroke : zc.ink === '#FFFFFF' ? zc.stroke : zc.ink) : c.ink), bold: true, align: 'left' },
      ]
    }
    case 'flow': {
      const kind = (o.props?.kind as FlowKind) || 'visitor'
      const col = o.color || t.flow[kind]
      const src: number[] = o.props?.pts || []
      const pts = src.map((v, i) => (i % 2 ? v - o.y : v - o.x))
      if (pts.length < 4) return []
      return [{ k: 'line', pts, stroke: col, sw: 120 * ss, arrow: true, op: 0.9, dash: kind === 'evac' ? [320 * ss, 220 * ss] : kind === 'staff' ? [120 * ss, 160 * ss] : undefined }]
    }

    case 'column':
      return o.props?.round
        ? [{ k: 'ellipse', cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, fill: t.column }]
        : [{ k: 'rect', x: 0, y: 0, w, h, fill: t.column }]
    case 'wall':
      return [{ k: 'rect', x: 0, y: 0, w, h, fill: t.wall }]
    case 'fixed': {
      const text = o.label || '固定設備'
      return [{ k: 'rect', x: 0, y: 0, w, h, fill: t.fixed, stroke: t.wall, sw: thin, text, ts: fitText(text, w, h, 420 * ss * L, 130 * ss), tc: t.fixedInk }]
    }
    case 'nogo': {
      const s = t.cat.safety
      const text = o.label || '使用不可'
      return [
        { k: 'rect', x: 0, y: 0, w, h, fill: s.fill, op: 0.5, stroke: s.stroke, sw: thin, dash: [160 * ss, 110 * ss] },
        { k: 'line', pts: [0, 0, w, h], stroke: s.stroke, sw: thin, op: 0.6 },
        { k: 'line', pts: [w, 0, 0, h], stroke: s.stroke, sw: thin, op: 0.6 },
        { k: 'text', x: 0, y: 0, w, h, text, size: fitText(text, w, h, 360 * ss * L, 0), color: s.ink, bold: true },
      ]
    }
    case 'entrance': {
      // ローカル上側が屋外、下側が室内。壁の中心線は y = h/2。
      const kind = (o.props?.kind as EntranceKind) || 'entrance'
      const col = t.door[kind]
      const T = env.wallT
      const y0 = h / 2 - T / 2
      const inward = kind === 'entrance' || kind === 'loading'
      const tipY = y0 - 160 * ss
      const baseY = tipY - 430 * ss
      const hw = 250 * ss
      const text = o.label || ENTRANCE_LABEL[kind]
      const size = 400 * ss * L
      const tOff = size * 0.75 + 60 * ss
      return [
        { k: 'rect', x: 0, y: y0 - 12, w, h: T + 24, fill: t.floor },
        { k: 'line', pts: [0, y0, 0, y0 + T], stroke: t.wall, sw: 60 * ss },
        { k: 'line', pts: [w, y0, w, y0 + T], stroke: t.wall, sw: 60 * ss },
        { k: 'line', pts: [0, h / 2, w, h / 2], stroke: col, sw: 80 * ss },
        { k: 'poly', pts: inward ? [w / 2 - hw, baseY, w / 2 + hw, baseY, w / 2, tipY] : [w / 2 - hw, tipY, w / 2 + hw, tipY, w / 2, baseY], closed: true, fill: col },
        { k: 'text', x: w / 2 - 1600 * ss, y: baseY - tOff - size * 0.65, w: 3200 * ss, h: size * 1.3, text, size, color: col, bold: true, along: true },
      ]
    }
  }
  return [box(name)]
}

/** 会場の床と壁（ワールド座標） */
/** 描画上の壁厚。大きな会場でも線が痩せないよう下限を設ける */
export function wallThickness(venue: Venue): number {
  return Math.max(venue.wallT, 150 * styleScale(venue.outline))
}

export function venuePrims(venue: Venue, t: Theme): { floor: Prim[]; walls: Prim[] } {
  const pts: number[] = []
  for (const p of venue.outline) pts.push(p.x, p.y)
  return {
    floor: [{ k: 'poly', pts, closed: true, fill: t.floor }],
    walls: [{ k: 'poly', pts, closed: true, stroke: t.wall, sw: wallThickness(venue) }],
  }
}

export const catName = (o: Obj) => CATALOG[o.type]?.name || o.type
