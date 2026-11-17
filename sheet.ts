// 1枚のシート（16:9スライド）に、図面・タイトル・概要・凡例・スケールバーを組む。
// 単位は pt（960×540）。SVG / PNG / PDF / PPTX がすべてこのシートから出力される。
import { CATALOG, FLOW_LABEL } from '../core/catalog'
import { transformPrims, visLen } from '../core/prims'
import type { Prim } from '../core/prims'
import { seatBlockers, seatCount, standingCap } from '../core/seats'
import { getTheme } from '../core/themes'
import type { Theme } from '../core/themes'
import type { FlowKind, Issue, Obj, Plan, PlanStats, Project } from '../core/types'
import { validate } from '../core/validate'
import { makeEnv, sceneBBox, scenePrims } from './scene'

export type SheetStyle = 'proposal' | 'ops' | 'pitch' | 'bare'
export const SHEET_STYLES: { id: SheetStyle; name: string; desc: string }[] = [
  { id: 'proposal', name: '企画書用', desc: '余白を活かした配置図。凡例・概要つき' },
  { id: 'ops', name: '運営スタッフ用', desc: '寸法・全動線・確認事項・設備リスト' },
  { id: 'pitch', name: 'プレゼン用', desc: 'ゾーニングと動線を大きく見せる' },
  { id: 'bare', name: '図面のみ', desc: '自分のスライドに貼る用。図面とスケールだけ' },
]

export interface SheetOpts {
  style: SheetStyle
  themeId: string
  withSource?: boolean
}

export interface Sheet {
  w: number
  h: number
  bg: string
  theme: Theme
  prims: Prim[]
  image?: { dataUrl: string; x: number; y: number; w: number; h: number; opacity: number }
  title: string
  notes: string
  stats: PlanStats
  issues: Issue[]
}

const EVENT_NAME: Record<string, string> = {
  conference: 'カンファレンス',
  exhibition: '展示会',
  ceremony: '式典',
  party: 'パーティー',
  live: 'ライブ・音楽フェス',
}

export function wrapText(text: string, maxLen: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    let len = 0
    for (const ch of para) {
      const l = visLen(ch)
      if (len + l > maxLen && line) {
        out.push(line)
        line = ''
        len = 0
      }
      line += ch
      len += l
    }
    if (line) out.push(line)
  }
  return out
}

export interface LegendItem {
  kind: 'box' | 'line'
  fill?: string
  stroke?: string
  dash?: boolean
  label: string
  value: string
}

export function legendItems(project: Project, plan: Plan, theme: Theme, flows: FlowKind[] | 'all' | 'none'): LegendItem[] {
  const env = { blockers: seatBlockers(project.structure, plan.objects), outline: project.venue.outline }
  const items: LegendItem[] = []
  const objs = plan.objects.filter((o) => !o.hidden)
  const by = (t: string) => objs.filter((o) => o.type === t)
  const m = (v: number) => (v / 1000).toFixed(1)

  const stage = by('stage')
  if (stage.length) {
    const s = stage[0]
    items.push({ kind: 'box', fill: theme.cat.production.fill, stroke: theme.cat.production.stroke, label: 'ステージ', value: `${m(s.w)}×${m(s.h)}m` })
  }
  const blocks = by('seat_block')
  const sum = (list: Obj[]) => list.reduce((a, o) => a + seatCount(o, env), 0)
  const vip = blocks.filter((o) => o.props?.style === 'vip')
  const th = blocks.filter((o) => (o.props?.style || 'theater') === 'theater')
  const cl = blocks.filter((o) => o.props?.style === 'classroom')
  if (vip.length) items.push({ kind: 'box', fill: theme.cat.exhibit.stroke, label: '来賓席', value: `${sum(vip)}席` })
  if (th.length) items.push({ kind: 'box', fill: theme.chair, label: '客席（シアター）', value: `${sum(th)}席` })
  if (cl.length) items.push({ kind: 'box', fill: theme.chair, label: '客席（スクール）', value: `${sum(cl)}席` })
  const rt = by('round_table')
  if (rt.length) items.push({ kind: 'box', fill: theme.tableTop, stroke: theme.cat.seating.stroke, label: '円卓', value: `${rt.length}卓・${sum(rt)}席` })
  const st = by('standing')
  if (st.length) items.push({ kind: 'box', fill: theme.cat.seating.fill, stroke: theme.cat.seating.stroke, dash: true, label: 'スタンディング', value: `約${st.reduce((a, o) => a + standingCap(o), 0)}人` })

  const rest: Record<string, number> = {}
  for (const o of objs) {
    if (['stage', 'seat_block', 'round_table', 'standing', 'zone', 'flow', 'label', 'podium', 'screen', 'partition'].includes(o.type)) continue
    const key = o.type + '|' + (o.label && o.type === 'generic' ? o.label : '')
    rest[key] = (rest[key] || 0) + 1
  }
  for (const key of Object.keys(rest)) {
    const [type, label] = key.split('|')
    const c = CATALOG[type as Obj['type']]
    const col = theme.cat[c.cat]
    items.push({ kind: 'box', fill: col.fill, stroke: col.stroke, label: label || c.name, value: `${rest[key]}${c.unit}` })
  }
  if (flows !== 'none') {
    const kinds = new Set(by('flow').map((o) => (o.props?.kind as FlowKind) || 'visitor'))
    for (const k of ['visitor', 'load', 'staff', 'evac'] as FlowKind[]) {
      if (!kinds.has(k)) continue
      if (flows !== 'all' && !flows.includes(k)) continue
      items.push({ kind: 'line', stroke: theme.flow[k], dash: k === 'evac', label: FLOW_LABEL[k], value: '' })
    }
  }
  return items
}

const W = 960
const H = 540

export function composeSheet(project: Project, plan: Plan, opts: SheetOpts): Sheet {
  const theme = getTheme(opts.themeId)
  const style = opts.style
  const t = theme
  const { issues, stats } = validate(project, plan)
  const flows: FlowKind[] | 'all' = style === 'ops' ? 'all' : style === 'pitch' ? ['visitor', 'load'] : ['visitor']
  const env = makeEnv(project, theme, style !== 'pitch', style === 'pitch' ? 1.3 : 1, plan)
  const withSource = !!opts.withSource && !!project.source
  const world = scenePrims(project, plan, env, { zones: style === 'pitch', flows, dims: style === 'ops', floor: !withSource })

  const panel = style !== 'bare'
  const area = panel ? { x: 34, y: 92, w: 640, h: 404 } : { x: 30, y: 30, w: W - 60, h: H - 84 }
  const bb = sceneBBox(project, style === 'ops')
  const s = Math.min(area.w / bb.w, area.h / bb.h)
  const tx = area.x + (area.w - bb.w * s) / 2 - bb.x * s
  const ty = area.y + (area.h - bb.h * s) / 2 - bb.y * s
  const prims: Prim[] = transformPrims(world, s, tx, ty)

  const txt = (x: number, y: number, w: number, text: string, size: number, color = t.ink, bold = false, align: 'left' | 'center' | 'right' = 'left'): Prim => ({
    k: 'text', x, y, w, h: size * 1.3, text, size, color, bold, align,
  })
  const head: Prim[] = []
  const title = project.brief.title || project.name
  const planTitle = `${plan.name}｜${plan.concept}`

  if (panel) {
    head.push(txt(34, 26, 640, title, 21, t.ink, true))
    head.push(txt(34, 56, 640, planTitle, 11.5, t.dark ? t.wall : t.sub, true))
    head.push({ k: 'line', pts: [34, 80, W - 34, 80], stroke: t.line, sw: 0.75 })
    head.push(txt(700, 30, 226, project.venue.name || '', 9, t.sub, false, 'right'))
    head.push(txt(700, 44, 226, new Date().toISOString().slice(0, 10), 9, t.sub, false, 'right'))

    // 右パネル
    const px = 700
    const pw = 226
    let y = 96
    const section = (label: string) => {
      head.push(txt(px, y, pw, label, 8.5, t.dark ? t.wall : t.sub, true))
      head.push({ k: 'line', pts: [px, y + 14, px + pw, y + 14], stroke: t.line, sw: 0.5 })
      y += 21
    }
    const row = (label: string, value: string) => {
      head.push(txt(px, y, pw * 0.5, label, 9.5, t.sub))
      head.push(txt(px + pw * 0.4, y, pw * 0.6, value, 9.5, t.ink, true, 'right'))
      y += 15.5
    }
    if (style === 'pitch') {
      for (const ln of wrapText(plan.rationale[0] || plan.concept, 19).slice(0, 5)) {
        head.push(txt(px, y, pw, ln, 11.5, t.ink, true))
        y += 17
      }
      y += 8
    }
    section('概要')
    row('イベント', EVENT_NAME[project.brief.eventType] || '')
    row('会場面積', `約${Math.round(stats.areaM2)}㎡`)
    row('来場者', `${project.brief.attendees}名`)
    if (stats.seats) row('客席', `${stats.seats}席`)
    if (stats.standing) row('スタンディング', `約${stats.standing}人`)
    if (stats.booths) row('展示ブース', `${stats.booths}小間`)
    if (stats.reception) row('受付', `${stats.reception}台`)
    y += 8

    if (style === 'pitch') {
      section('ゾーニング')
      for (const z of plan.objects.filter((o) => o.type === 'zone')) {
        const zc = z.props?.zcat ? t.cat[z.props.zcat as keyof typeof t.cat] : t.cat.zone
        head.push({ k: 'rect', x: px, y: y + 1.5, w: 11, h: 9, r: 1.5, fill: zc.stroke, op: 0.25, stroke: zc.stroke, sw: 0.75 })
        head.push(txt(px + 17, y, pw - 17, z.label || 'ゾーン', 9.5, t.ink))
        y += 15.5
      }
      y += 8
    }
    section('凡例')
    const items = legendItems(project, plan, theme, flows)
    const maxItems = Math.max(4, Math.floor((H - 60 - y - (style === 'pitch' ? 0 : 90)) / 15.5))
    for (const it of items.slice(0, maxItems)) {
      if (it.kind === 'box') head.push({ k: 'rect', x: px, y: y + 1.5, w: 11, h: 9, r: 1.5, fill: it.fill, stroke: it.stroke, sw: it.stroke ? 0.6 : 0, dash: it.dash ? [2, 1.5] : undefined })
      else head.push({ k: 'line', pts: [px, y + 6, px + 12, y + 6], stroke: it.stroke || t.ink, sw: 1.6, dash: it.dash ? [3, 2] : undefined, arrow: true })
      head.push(txt(px + 17, y, pw - 17, it.label, 9.5, t.ink))
      if (it.value) head.push(txt(px + pw * 0.4, y, pw * 0.6, it.value, 9.5, t.ink, true, 'right'))
      y += 15.5
    }
    y += 8

    if (style === 'proposal' && y < H - 110) {
      section('レイアウトの考え方')
      const lines = plan.rationale.flatMap((r) => wrapText(r, 23))
      for (const ln of lines.slice(0, Math.max(2, Math.floor((H - 50 - y) / 14)))) {
        head.push(txt(px, y, pw, ln, 9, t.ink))
        y += 14
      }
    }
    if (style === 'ops' && y < H - 90) {
      section('確認事項')
      const list = issues.filter((i) => i.sev === 'error' || i.sev === 'warn')
      if (!list.length) {
        head.push(txt(px, y, pw, '重なり・通路・出入口に問題は見つかっていません', 9, t.ink))
        y += 14
      }
      for (const i of list.slice(0, Math.max(2, Math.floor((H - 50 - y) / 14)))) {
        const mark = i.sev === 'error' ? '●' : '▲'
        const col = i.sev === 'error' ? t.cat.safety.stroke : t.flow.load
        head.push(txt(px, y, 10, mark, 7.5, col))
        const ls = wrapText(i.title, 21)
        head.push(txt(px + 11, y, pw - 11, ls[0], 9, t.ink))
        y += 14
      }
    }
  }

  // スケールバー
  const nice = [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]
  let L = nice[0]
  for (const v of nice) if (v * s <= 130) L = v
  const bx = area.x
  const by = panel ? 512 : H - 30
  const bl = L * s
  head.push({ k: 'line', pts: [bx, by, bx + bl, by], stroke: t.ink, sw: 1.1 })
  head.push({ k: 'line', pts: [bx, by - 3.5, bx, by + 3.5], stroke: t.ink, sw: 1.1 })
  head.push({ k: 'line', pts: [bx + bl / 2, by - 2.5, bx + bl / 2, by + 2.5], stroke: t.ink, sw: 0.8 })
  head.push({ k: 'line', pts: [bx + bl, by - 3.5, bx + bl, by + 3.5], stroke: t.ink, sw: 1.1 })
  head.push(txt(bx + bl + 7, by - 6, 60, L >= 1000 ? `${L / 1000} m` : `${L} mm`, 8.5, t.ink))
  const ratio = Math.round(1 / (s * 0.3528) / 10) * 10
  head.push(txt(bx + bl + 60, by - 6, 220, `縮尺の目安 1:${ratio}（16:9スライド原寸）`, 8, t.sub))
  if (project.source && !project.source.scaleKnown) head.push(txt(bx + bl + 250, by - 6, 200, '※ 縮尺未確定', 8, t.cat.safety.stroke))
  if (panel) head.push(txt(W - 34 - 320, by - 6, 320, '避難・収容は施設規定と消防協議で確認してください', 7.5, t.sub, false, 'right'))

  const sheet: Sheet = {
    w: W,
    h: H,
    bg: t.paper,
    theme,
    prims: [...prims, ...head],
    title: `${title} ${plan.name}`,
    notes: [
      `${title}｜${planTitle}`,
      ...plan.rationale,
      `会場 約${Math.round(stats.areaM2)}㎡ / 来場 ${project.brief.attendees}名 / 客席 ${stats.seats}席${stats.standing ? ` / スタンディング 約${stats.standing}人` : ''}${stats.booths ? ` / 展示ブース ${stats.booths}小間` : ''}`,
      ...issues.filter((i) => i.sev !== 'ok').map((i) => `${i.sev === 'error' ? '[要修正]' : i.sev === 'warn' ? '[注意]' : '[メモ]'} ${i.title}`),
    ].join('\n'),
    stats,
    issues,
  }
  if (withSource && project.source) {
    const src = project.source
    sheet.image = { dataUrl: src.dataUrl, x: src.x * s + tx, y: src.y * s + ty, w: src.wPx * src.mmPerPx * s, h: src.hPx * src.mmPerPx * s, opacity: 0.4 }
  }
  return sheet
}

/** 設備リスト（運営用の表） */
export function equipmentRows(project: Project, plan: Plan): string[][] {
  const env = { blockers: seatBlockers(project.structure, plan.objects), outline: project.venue.outline }
  const map = new Map<string, { name: string; n: number; size: string; note: string }>()
  for (const o of plan.objects) {
    if (o.hidden || o.type === 'zone' || o.type === 'flow' || o.type === 'label') continue
    const c = CATALOG[o.type]
    const size = `${(o.w / 1000).toFixed(1)}×${(o.h / 1000).toFixed(1)}`
    let note = ''
    let key = `${o.type}|${o.label || ''}|${size}`
    if (o.type === 'seat_block') {
      const style = o.props?.style === 'classroom' ? 'スクール' : o.props?.style === 'vip' ? '来賓' : 'シアター'
      key = `seat|${style}`
      const cur = map.get(key)
      const seats = seatCount(o, env)
      if (cur) {
        cur.n += 1
        cur.note = `計 ${Number(cur.note.replace(/\D/g, '')) + seats}席`
      } else map.set(key, { name: `客席ブロック（${style}）`, n: 1, size: '—', note: `計 ${seats}席` })
      continue
    }
    if (o.type === 'round_table') note = `${o.props?.seats ?? 10}席/卓`
    if (o.type === 'standing') note = `約${standingCap(o)}人（${o.props?.density ?? 1.5}人/㎡）`
    if (o.type === 'booth') key = `booth|${size}`
    const cur = map.get(key)
    if (cur) cur.n += 1
    else map.set(key, { name: o.type === 'booth' ? c.name : o.label || c.name, n: 1, size, note })
  }
  const rows: string[][] = []
  let i = 1
  for (const v of map.values()) rows.push([String(i++), v.name, String(v.n), v.size, v.note])
  return rows
}
