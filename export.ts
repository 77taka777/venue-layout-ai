// 出力：PPTX（ネイティブ図形）/ SVG / PNG / PDF / プロジェクトJSON
import { drawPrims } from '../core/prims'
import type { Plan, Project } from '../core/types'
import { loadImageEl } from '../io/files'
import { buildPptx } from './pptx'
import type { PptxOpts } from './pptx'
import { composeSheet } from './sheet'
import type { Sheet, SheetOpts } from './sheet'
import { sheetToSvg } from './svg'

export async function sheetToCanvas(sheet: Sheet, scale = 3): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas')
  c.width = Math.round(sheet.w * scale)
  c.height = Math.round(sheet.h * scale)
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.scale(scale, scale)
  ctx.fillStyle = sheet.bg
  ctx.fillRect(0, 0, sheet.w, sheet.h)
  if (sheet.image) {
    try {
      const img = await loadImageEl(sheet.image.dataUrl)
      ctx.globalAlpha = sheet.image.opacity
      ctx.drawImage(img, sheet.image.x, sheet.image.y, sheet.image.w, sheet.image.h)
      ctx.globalAlpha = 1
    } catch {
      // 元図面が描けなくても図面自体は出力する
    }
  }
  drawPrims(ctx, sheet.prims)
  return c
}

const blobOf = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('書き出しに失敗しました'))), type, q))

export async function exportPptx(project: Project, plans: Plan[], opts: PptxOpts): Promise<Blob> {
  const mod: any = await import('pptxgenjs')
  const Ctor = mod.default?.default || mod.default || mod
  const pptx = buildPptx(Ctor, project, plans, opts)
  return (await pptx.write({ outputType: 'blob' })) as Blob
}

export function exportSvg(project: Project, plan: Plan, opts: SheetOpts): string {
  return sheetToSvg(composeSheet(project, plan, opts))
}

export async function exportPng(project: Project, plan: Plan, opts: SheetOpts): Promise<Blob> {
  return blobOf(await sheetToCanvas(composeSheet(project, plan, opts), 3), 'image/png')
}

export async function exportPdf(project: Project, plans: Plan[], styles: SheetOpts['style'][], themeId: string, withSource: boolean): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [960, 540], compress: true })
  let first = true
  for (const plan of plans) {
    for (const style of styles) {
      const sheet = composeSheet(project, plan, { style, themeId, withSource })
      const canvas = await sheetToCanvas(sheet, 3)
      if (!first) doc.addPage([960, 540], 'landscape')
      first = false
      doc.addImage(canvas.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, 960, 540, undefined, 'FAST')
    }
  }
  return doc.output('blob')
}

export function safeName(s: string): string {
  return (s || 'floorplan').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
}
