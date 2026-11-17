import fs from 'node:fs'
import PptxMod from 'pptxgenjs'
import { generatePlans } from '../src/core/planner'
import { sampleProject, makeEntrance } from '../src/core/structure'
import { validate } from '../src/core/validate'
import { getTheme } from '../src/core/themes'
import { composeSheet } from '../src/render/sheet'
import { sheetToSvg, planSvg } from '../src/render/svg'
import { buildPptx } from '../src/render/pptx'
import type { Project } from '../src/core/types'

const Pptx: any = (PptxMod as any).default?.default || (PptxMod as any).default || PptxMod

function run(name: string, p: Project, themeId = 'light') {
  const t0 = Date.now()
  p.plans = generatePlans(p)
  const ms = Date.now() - t0
  console.log(`\n=== ${name} (${ms}ms)`)
  for (const pl of p.plans) {
    const { issues, stats } = validate(p, pl)
    const err = issues.filter((i) => i.sev === 'error')
    const warn = issues.filter((i) => i.sev === 'warn')
    console.log(`${pl.name} ${pl.concept}: objs=${pl.objects.length} seats=${stats.seats} standing=${stats.standing} booths=${stats.booths} rec=${stats.reception} exitDist=${stats.maxExitDistM} | err=${err.length} warn=${warn.length}`)
    for (const i of [...err, ...warn]) console.log(`   [${i.sev}] ${i.title} ${i.detail || ''}`)
    for (const n of pl.notes) console.log(`   note: ${n}`)
    fs.writeFileSync(`out/${name}-${pl.name[0]}.svg`, planSvg(p, pl, getTheme(themeId)))
  }
  return p
}

const which = process.argv[2] || 'all'
const base = sampleProject()
if (which === 'all' || which === 'conf') {
  const p = run('conf', structuredClone(base))
  for (const style of ['proposal', 'ops', 'pitch', 'bare'] as const) fs.writeFileSync(`out/sheet-${style}.svg`, sheetToSvg(composeSheet(p, p.plans[0], { style, themeId: 'light' })))
  fs.writeFileSync('out/sheet-noir.svg', sheetToSvg(composeSheet(p, p.plans[1], { style: 'proposal', themeId: 'noir' })))
  fs.writeFileSync('out/sheet-blue.svg', sheetToSvg(composeSheet(p, p.plans[2], { style: 'pitch', themeId: 'blueprint' })))
  const pptx = buildPptx(Pptx, p, [p.plans[0]], { styles: ['proposal', 'ops', 'pitch', 'bare'], themeId: 'light' })
  const buf = await pptx.write({ outputType: 'nodebuffer' })
  fs.writeFileSync('out/sample.pptx', buf)
  const pptx2 = buildPptx(Pptx, p, [p.plans[1]], { styles: ['proposal'], themeId: 'noir' })
  fs.writeFileSync('out/sample-noir.pptx', await pptx2.write({ outputType: 'nodebuffer' }))
  console.log('pptx written', buf.length)
}
if (which === 'all' || which === 'types') {
  for (const et of ['exhibition', 'ceremony', 'party', 'live'] as const) {
    const p = structuredClone(base)
    p.brief.eventType = et
    if (et === 'exhibition') { p.brief.booths = 40; p.brief.stage = false; p.brief.seats = 0; p.brief.attendees = 800; p.brief.lounge = true }
    if (et === 'ceremony') { p.brief.booths = 0; p.brief.vipSeats = 20; p.brief.seats = 200; p.brief.attendees = 200; p.brief.cloak = true }
    if (et === 'party') { p.brief.booths = 0; p.brief.seats = 150; p.brief.attendees = 150; p.brief.food = 3; p.brief.foh = false; p.brief.screen = false }
    if (et === 'live') { p.brief.booths = 0; p.brief.attendees = 700; p.brief.seats = 0; p.brief.food = 3; p.brief.merch = 2; p.brief.firstaid = true; p.brief.reception = 2; p.brief.podium = false; p.brief.screen = false }
    run(et, p)
  }
}
if (which === 'all' || which === 'shapes') {
  // L字型の会場
  const L = structuredClone(base)
  L.venue.outline = [{ x: 0, y: 0 }, { x: 36000, y: 0 }, { x: 36000, y: 14000 }, { x: 22000, y: 14000 }, { x: 22000, y: 26000 }, { x: 0, y: 26000 }]
  L.structure = [makeEntrance(L.venue, { x: 10000, y: 26000 }, 2400, 'entrance'), makeEntrance(L.venue, { x: 36000, y: 7000 }, 1800, 'emergency'), makeEntrance(L.venue, { x: 0, y: 5000 }, 3000, 'loading')]
  run('lshape', L)
  // 小さな部屋・入口が側面
  const S = structuredClone(base)
  S.venue.outline = [{ x: 0, y: 0 }, { x: 12000, y: 0 }, { x: 12000, y: 9000 }, { x: 0, y: 9000 }]
  S.structure = [makeEntrance(S.venue, { x: 0, y: 7000 }, 1200, 'entrance')]
  S.brief.attendees = 40; S.brief.seats = 40; S.brief.booths = 0; S.brief.reception = 1
  run('small', S)
  // 大きな展示ホール
  const B = structuredClone(base)
  B.venue.outline = [{ x: 0, y: 0 }, { x: 90000, y: 0 }, { x: 90000, y: 60000 }, { x: 0, y: 60000 }]
  B.structure = [makeEntrance(B.venue, { x: 45000, y: 60000 }, 6000, 'entrance'), makeEntrance(B.venue, { x: 0, y: 30000 }, 3000, 'emergency'), makeEntrance(B.venue, { x: 90000, y: 30000 }, 3000, 'emergency'), makeEntrance(B.venue, { x: 20000, y: 0 }, 6000, 'loading')]
  for (let i = 1; i < 5; i++) for (let j = 1; j < 3; j++) B.structure.push({ id: 'c' + i + j, type: 'column', x: i * 18000 - 400, y: j * 20000 - 400, w: 800, h: 800, rot: 0 })
  B.brief.eventType = 'exhibition'; B.brief.booths = 220; B.brief.attendees = 5000; B.brief.stage = true; B.brief.seats = 120; B.brief.reception = 6
  run('bighall', B)
}
