// プロジェクト＋配置案 → ワールド座標(mm)のプリミティブ列。SVG・PPTX・PNG・サムネイルの共通の元。
import { CATALOG } from '../core/catalog'
import { ptsBBox } from '../core/geometry'
import { glyph, styleScale, venuePrims, wallThickness } from '../core/glyphs'
import type { GlyphEnv } from '../core/glyphs'
import { flatten, visLen } from '../core/prims'
import type { Prim } from '../core/prims'
import { seatBlockers } from '../core/seats'
import type { Theme } from '../core/themes'
import type { FlowKind, LayerId, Obj, Plan, Project, Rect } from '../core/types'

export interface SceneOpts {
  zones: boolean
  flows: FlowKind[] | 'all' | 'none'
  hidden?: LayerId[]
  dims?: boolean
  floor?: boolean
}

export function makeEnv(project: Project, theme: Theme, seatDetail = true, labelScale = 1, plan: Plan | null = null): GlyphEnv {
  return {
    theme,
    ss: styleScale(project.venue.outline),
    wallT: wallThickness(project.venue),
    seatDetail,
    labelScale,
    blockers: seatBlockers(project.structure, plan ? plan.objects : null),
    outline: project.venue.outline,
  }
}

const zOf = (o: Obj) => CATALOG[o.type]?.z ?? 8

export function scenePrims(project: Project, plan: Plan | null, env: GlyphEnv, opts: SceneOpts): Prim[] {
  const hidden = new Set(opts.hidden || [])
  const out: Prim[] = []
  const vp = venuePrims(project.venue, env.theme)
  if (opts.floor !== false) out.push(...vp.floor)
  const struct = hidden.has('structure') ? [] : project.structure.filter((s) => !s.hidden)
  const objs = plan ? plan.objects.filter((o) => !o.hidden) : []
  const draw = (o: Obj) => out.push(...flatten(o, glyph(o, env)))

  // ゾーンは面を先に、名前は最後に（什器の上に）描く
  const zoneLabels: Prim[] = []
  if (opts.zones && !hidden.has('zone')) {
    for (const z of objs.filter((o) => o.type === 'zone')) {
      for (const p of flatten(z, glyph(z, env))) {
        if (p.k === 'text') {
          const tw = visLen(p.text) * p.size + p.size * 0.9
          zoneLabels.push({ k: 'rect', x: p.x - p.size * 0.35, y: p.y - p.size * 0.1, w: tw, h: p.size * 1.5, r: p.size * 0.3, fill: env.theme.paper, op: 0.86 })
          zoneLabels.push(p)
        } else out.push(p)
      }
    }
  }
  struct.filter((s) => s.type === 'fixed' || s.type === 'nogo').forEach(draw)
  objs
    .filter((o) => o.type !== 'zone' && o.type !== 'flow' && o.type !== 'label' && !hidden.has(CATALOG[o.type].layer))
    .slice()
    .sort((a, b) => zOf(a) - zOf(b))
    .forEach(draw)
  out.push(...vp.walls)
  struct.filter((s) => s.type === 'column' || s.type === 'wall').forEach(draw)
  struct.filter((s) => s.type === 'entrance').forEach(draw)
  if (opts.flows !== 'none' && !hidden.has('flow')) {
    objs
      .filter((o) => o.type === 'flow' && (opts.flows === 'all' || (opts.flows as FlowKind[]).includes((o.props?.kind as FlowKind) || 'visitor')))
      .forEach(draw)
  }
  out.push(...zoneLabels)
  if (!hidden.has('note')) objs.filter((o) => o.type === 'label').forEach(draw)
  if (opts.dims) out.push(...dimPrims(project, env))
  return out
}

/** 外形寸法（運営用） */
function dimPrims(project: Project, env: GlyphEnv): Prim[] {
  const bb = ptsBBox(project.venue.outline)
  const { ss, theme: t } = env
  const off = 2000 * ss
  const tick = 260 * ss
  const sw = 28 * ss
  const size = 520 * ss
  const y = bb.y - off
  const x = bb.x - off
  const mm = (v: number) => `${(v / 1000).toFixed(1)} m`
  return [
    { k: 'line', pts: [bb.x, y, bb.x + bb.w, y], stroke: t.sub, sw },
    { k: 'line', pts: [bb.x, y - tick, bb.x, y + tick], stroke: t.sub, sw },
    { k: 'line', pts: [bb.x + bb.w, y - tick, bb.x + bb.w, y + tick], stroke: t.sub, sw },
    { k: 'text', x: bb.x, y: y - size * 1.5, w: bb.w, h: size * 1.3, text: mm(bb.w), size, color: t.sub },
    { k: 'line', pts: [x, bb.y, x, bb.y + bb.h], stroke: t.sub, sw },
    { k: 'line', pts: [x - tick, bb.y, x + tick, bb.y], stroke: t.sub, sw },
    { k: 'line', pts: [x - tick, bb.y + bb.h, x + tick, bb.y + bb.h], stroke: t.sub, sw },
    { k: 'text', x: x - size * 0.9 - bb.h / 2, y: bb.y + bb.h / 2 - size * 0.65, w: bb.h, h: size * 1.3, rot: 270, text: mm(bb.h), size, color: t.sub },
  ]
}

/** 図面全体が収まる範囲（出入口ラベルや寸法線の分を含む） */
export function sceneBBox(project: Project, dims = false): Rect {
  const bb = ptsBBox(project.venue.outline)
  const ss = styleScale(project.venue.outline)
  const pad = (dims ? 3000 : 1700) * ss
  return { x: bb.x - pad, y: bb.y - pad, w: bb.w + pad * 2, h: bb.h + pad * 2 }
}
