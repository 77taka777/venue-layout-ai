import { FONT_STACK, primsToSvg } from '../core/prims'
import type { Theme } from '../core/themes'
import type { Plan, Project } from '../core/types'
import { makeEnv, sceneBBox, scenePrims } from './scene'
import type { Sheet } from './sheet'

const FONT_ATTR = FONT_STACK.replace(/"/g, "'")

export function sheetToSvg(sheet: Sheet): string {
  const img = sheet.image
    ? `<image href="${sheet.image.dataUrl}" x="${sheet.image.x.toFixed(2)}" y="${sheet.image.y.toFixed(2)}" width="${sheet.image.w.toFixed(2)}" height="${sheet.image.h.toFixed(2)}" opacity="${sheet.image.opacity}" preserveAspectRatio="none"/>`
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sheet.w} ${sheet.h}" width="${sheet.w * 2}" height="${sheet.h * 2}" font-family="${FONT_ATTR}">` +
    `<rect width="${sheet.w}" height="${sheet.h}" fill="${sheet.bg}"/>${img}${primsToSvg(sheet.prims)}</svg>`
  )
}

/** 配置案のサムネイル用（図面部分だけ、ワールド座標のまま） */
export function planSvg(project: Project, plan: Plan | null, theme: Theme, opts: { zones?: boolean; detail?: boolean } = {}): string {
  const env = makeEnv(project, theme, opts.detail !== false, 1, plan)
  const prims = scenePrims(project, plan, env, { zones: !!opts.zones, flows: ['visitor'] })
  const bb = sceneBBox(project)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb.x.toFixed(0)} ${bb.y.toFixed(0)} ${bb.w.toFixed(0)} ${bb.h.toFixed(0)}" font-family="${FONT_ATTR}" preserveAspectRatio="xMidYMid meet">` +
    `<rect x="${bb.x.toFixed(0)}" y="${bb.y.toFixed(0)}" width="${bb.w.toFixed(0)}" height="${bb.h.toFixed(0)}" fill="${theme.paper}"/>${primsToSvg(prims)}</svg>`
  )
}
