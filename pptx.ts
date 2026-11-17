// シート → PowerPoint。画像1枚ではなく、壁・柱・ステージ・席・ブース・矢印・文字を
// それぞれ PowerPoint のネイティブ図形として書き出す（PowerPoint上で個別に動かせる）。
import type { Prim } from '../core/prims'
import type { Plan, Project } from '../core/types'
import { composeSheet, equipmentRows } from './sheet'
import type { Sheet, SheetStyle } from './sheet'

const hex = (c: string) => c.replace('#', '').toUpperCase()
const IN = (pt: number) => pt / 72
const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s)

export interface PptxOpts {
  styles: SheetStyle[]
  themeId: string
  withSource?: boolean
  equipment?: boolean
}

function lineOpts(p: { stroke?: string; sw?: number; dash?: number[]; op?: number }, extra: Record<string, any> = {}) {
  if (!p.stroke || !p.sw) return { type: 'none' as const }
  const o: Record<string, any> = { color: hex(p.stroke), width: Math.max(0.25, Math.round(p.sw * 100) / 100), ...extra }
  if (p.dash?.length) o.dashType = 'dash'
  return o
}
function fillOpts(p: { fill?: string; op?: number }) {
  if (!p.fill) return { type: 'none' as const }
  const o: Record<string, any> = { color: hex(p.fill) }
  if (p.op !== undefined && p.op < 1) o.transparency = Math.round((1 - p.op) * 100)
  return o
}

function addPrim(pptx: any, slide: any, p: Prim, sheet: Sheet) {
  const T = sheet.theme
  const face = (s: string) => (isAscii(s) ? T.fontEn : T.fontJa)
  switch (p.k) {
    case 'rect':
    case 'ellipse': {
      const box = p.k === 'rect' ? { x: p.x, y: p.y, w: p.w, h: p.h } : { x: p.cx - p.rx, y: p.cy - p.ry, w: p.rx * 2, h: p.ry * 2 }
      if (box.w <= 0 || box.h <= 0) return
      const round = p.k === 'rect' && !!p.r
      const shape = p.k === 'ellipse' ? pptx.ShapeType.ellipse : round ? pptx.ShapeType.roundRect : pptx.ShapeType.rect
      const base: Record<string, any> = { x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), fill: fillOpts(p), line: lineOpts(p) }
      if (p.k === 'rect' && p.rot) base.rotate = Math.round(p.rot)
      if (round) base.rectRadius = IN(Math.min(p.r as number, box.w / 2, box.h / 2))
      const text = p.text && p.ts && p.ts >= 3.5 ? p.text : ''
      if (text) {
        slide.addText(text, { ...base, shape, fontSize: Math.round((p.ts as number) * 10) / 10, color: hex(p.tc || T.ink), bold: !!p.tb, align: 'center', valign: 'middle', margin: 0, fontFace: face(text), wrap: false, fit: 'none' })
      } else slide.addShape(shape, base)
      return
    }
    case 'poly': {
      const n = p.pts.length / 2
      if (n < 2) return
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (let i = 0; i < p.pts.length; i += 2) {
        x0 = Math.min(x0, p.pts[i]); x1 = Math.max(x1, p.pts[i])
        y0 = Math.min(y0, p.pts[i + 1]); y1 = Math.max(y1, p.pts[i + 1])
      }
      if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return
      const points: any[] = []
      for (let i = 0; i < p.pts.length; i += 2) points.push({ x: IN(p.pts[i] - x0), y: IN(p.pts[i + 1] - y0) })
      if (p.closed) points.push({ close: true })
      slide.addShape(pptx.ShapeType.custGeom, { x: IN(x0), y: IN(y0), w: IN(x1 - x0), h: IN(y1 - y0), points, fill: fillOpts(p), line: lineOpts(p) })
      return
    }
    case 'line': {
      const n = p.pts.length / 2
      if (n < 2) return
      const lo = lineOpts(p, p.arrow ? { endArrowType: 'triangle' } : {})
      if (p.op !== undefined && p.op < 1) (lo as any).transparency = Math.round((1 - p.op) * 100)
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (let i = 0; i < p.pts.length; i += 2) {
        x0 = Math.min(x0, p.pts[i]); x1 = Math.max(x1, p.pts[i])
        y0 = Math.min(y0, p.pts[i + 1]); y1 = Math.max(y1, p.pts[i + 1])
      }
      const degenerate = x1 - x0 < 0.05 || y1 - y0 < 0.05
      if (n === 2 || degenerate) {
        const ax = p.pts[0]
        const ay = p.pts[1]
        const bx = p.pts[p.pts.length - 2]
        const by = p.pts[p.pts.length - 1]
        slide.addShape(pptx.ShapeType.line, {
          x: IN(Math.min(ax, bx)), y: IN(Math.min(ay, by)), w: IN(Math.abs(bx - ax)), h: IN(Math.abs(by - ay)),
          flipH: bx < ax, flipV: by < ay, line: lo,
        })
        return
      }
      const points: any[] = []
      for (let i = 0; i < p.pts.length; i += 2) points.push({ x: IN(p.pts[i] - x0), y: IN(p.pts[i + 1] - y0) })
      slide.addShape(pptx.ShapeType.custGeom, { x: IN(x0), y: IN(y0), w: IN(x1 - x0), h: IN(y1 - y0), points, fill: { type: 'none' }, line: lo })
      return
    }
    case 'text': {
      if (!p.text || p.size < 3.5) return
      const o: Record<string, any> = {
        x: IN(p.x), y: IN(p.y), w: IN(p.w), h: IN(p.h), fontSize: Math.round(p.size * 10) / 10, color: hex(p.color), bold: !!p.bold,
        align: p.align || 'center', valign: 'middle', margin: 0, fontFace: face(p.text), wrap: false, fit: 'none',
      }
      if (p.rot) o.rotate = Math.round(p.rot)
      if (p.op !== undefined && p.op < 1) o.transparency = Math.round((1 - p.op) * 100)
      slide.addText(p.text, o)
      return
    }
  }
}

export function addSheetSlide(pptx: any, sheet: Sheet) {
  const slide = pptx.addSlide()
  slide.background = { color: hex(sheet.bg) }
  if (sheet.image) {
    slide.addImage({ data: sheet.image.dataUrl, x: IN(sheet.image.x), y: IN(sheet.image.y), w: IN(sheet.image.w), h: IN(sheet.image.h), transparency: Math.round((1 - sheet.image.opacity) * 100) })
  }
  for (const p of sheet.prims) addPrim(pptx, slide, p, sheet)
  slide.addNotes(sheet.notes)
  return slide
}

function addEquipmentSlide(pptx: any, project: Project, plan: Plan, sheet: Sheet) {
  const T = sheet.theme
  const slide = pptx.addSlide()
  slide.background = { color: hex(T.paper) }
  slide.addText(`設備リスト｜${plan.name} ${plan.concept}`, { x: IN(34), y: IN(26), w: IN(892), h: IN(30), fontSize: 20, bold: true, color: hex(T.ink), fontFace: T.fontJa, margin: 0 })
  slide.addText(project.brief.title || project.name, { x: IN(34), y: IN(56), w: IN(892), h: IN(18), fontSize: 11, color: hex(T.sub), fontFace: T.fontJa, margin: 0 })
  const head = ['No.', '名称', '数量', 'サイズ (m)', '備考']
  const cell = (text: string, bold = false, fill?: string, color?: string) => ({
    text,
    options: { bold, fontSize: 10.5, fontFace: T.fontJa, color: hex(color || T.ink), fill: fill ? { color: hex(fill) } : undefined, valign: 'middle' as const },
  })
  const rows = [head.map((h) => cell(h, true, T.dark ? T.fixed : T.floor, T.sub)), ...equipmentRows(project, plan).slice(0, 18).map((r) => r.map((c) => cell(c)))]
  slide.addTable(rows, {
    x: IN(34), y: IN(92), w: IN(892), colW: [IN(50), IN(330), IN(80), IN(150), IN(282)],
    border: { type: 'solid', color: hex(T.line), pt: 0.5 }, rowH: IN(21), margin: [2, 6, 2, 6],
  })
  slide.addNotes('設備リストは図面上のオブジェクトから自動集計しています。')
}

/** PptxGenJS のコンストラクタを受け取り、プレゼンテーションを組み立てて返す */
export function buildPptx(PptxCtor: any, project: Project, plans: Plan[], opts: PptxOpts): any {
  const pptx = new PptxCtor()
  pptx.layout = 'LAYOUT_WIDE' // 13.33 × 7.5 in = 960 × 540 pt
  pptx.title = project.brief.title || project.name
  pptx.author = 'Event Floorplan AI'
  pptx.company = ''
  for (const plan of plans) {
    for (const style of opts.styles) {
      const sheet = composeSheet(project, plan, { style, themeId: opts.themeId, withSource: opts.withSource })
      addSheetSlide(pptx, sheet)
      if (style === 'ops' && opts.equipment !== false) addEquipmentSlide(pptx, project, plan, sheet)
    }
  }
  return pptx
}
