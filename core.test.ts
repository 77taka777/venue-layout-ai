import PptxMod from 'pptxgenjs'
import { describe, expect, it } from 'vitest'
import { applyAnalysis } from '../src/core/analysis'
import { applyChatOps } from '../src/core/ops'
import { generatePlans } from '../src/core/planner'
import { makeEntrance, sampleProject } from '../src/core/structure'
import { validate } from '../src/core/validate'
import { buildPptx } from '../src/render/pptx'
import { composeSheet } from '../src/render/sheet'
import { sheetToSvg } from '../src/render/svg'

const Pptx: any = (PptxMod as any).default?.default || (PptxMod as any).default || PptxMod
const withPlans = () => {
  const p = sampleProject()
  p.plans = generatePlans(p)
  p.activePlan = p.plans[0].id
  return p
}

describe('配置エンジン', () => {
  it('サンプル会場で3案を作り、重なり・はみ出し・入口ふさぎがない', () => {
    const p = withPlans()
    expect(p.plans).toHaveLength(3)
    for (const plan of p.plans) {
      const { issues } = validate(p, plan)
      expect(issues.filter((i) => i.sev === 'error')).toEqual([])
    }
  })

  it('A案は客席300・展示ブース5・受付3の要件を満たす', () => {
    const p = withPlans()
    const { stats, issues } = validate(p, p.plans[0])
    expect(stats.seats).toBeGreaterThanOrEqual(300)
    expect(stats.booths).toBe(5)
    expect(stats.reception).toBe(3)
    expect(issues.filter((i) => i.sev === 'warn')).toEqual([])
  })

  it.each(['exhibition', 'ceremony', 'party', 'live'] as const)('%s でもエラーなく配置できる', (eventType) => {
    const p = sampleProject()
    p.brief = { ...p.brief, eventType, booths: eventType === 'exhibition' ? 30 : 0, food: 2 }
    for (const plan of generatePlans(p)) {
      expect(plan.objects.length).toBeGreaterThan(3)
      expect(validate(p, plan).issues.filter((i) => i.sev === 'error')).toEqual([])
    }
  })

  it('L字型の会場でも配置できる', () => {
    const p = sampleProject()
    p.venue.outline = [{ x: 0, y: 0 }, { x: 36000, y: 0 }, { x: 36000, y: 14000 }, { x: 22000, y: 14000 }, { x: 22000, y: 26000 }, { x: 0, y: 26000 }]
    p.structure = [makeEntrance(p.venue, { x: 10000, y: 26000 }, 2400, 'entrance'), makeEntrance(p.venue, { x: 36000, y: 7000 }, 1800, 'emergency')]
    for (const plan of generatePlans(p)) expect(validate(p, plan).issues.filter((i) => i.sev === 'error')).toEqual([])
  })
})

describe('AI結果の取り込み', () => {
  it('読み取り結果（0–1000座標）を mm の会場データに変換する', () => {
    const p = sampleProject()
    p.source = { name: 'x.png', kind: 'image', dataUrl: 'data:,', wPx: 1000, hPx: 800, mmPerPx: 30, x: 0, y: 0, opacity: 0.5, scaleKnown: false }
    const next = applyAnalysis(p, {
      outline: [[100, 100], [900, 104], [900, 700], [100, 696]],
      openings: [{ kind: 'entrance', x1: 450, y1: 700, x2: 510, y2: 700 }],
      columns: [{ x: 300, y: 300, w: 15, h: 18 }],
      scale: { x1: 100, y1: 100, x2: 900, y2: 100, length_mm: 40000, evidence: '40,000' },
    })
    expect(next.source?.scaleKnown).toBe(true)
    expect(next.venue.outline).toHaveLength(4)
    const xs = next.venue.outline.map((q) => q.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40000, -2)
    expect(next.structure.filter((s) => s.type === 'entrance')).toHaveLength(1)
    expect(next.structure.filter((s) => s.type === 'column')).toHaveLength(1)
  })

  it('チャット編集の操作を適用する', () => {
    const p = withPlans()
    const stage = p.plans[0].objects.find((o) => o.type === 'stage')!
    const r = applyChatOps(p, [{ op: 'update', id: stage.id, scale: 1.2 }, { op: 'add', type: 'cloak', cx: 5, cy: 5 }, { op: 'remove', id: 'nope' }, { op: 'replan', brief: { booths: 3 } }])
    expect(r.applied).toBe(3)
    expect(r.skipped).toHaveLength(1)
    expect(r.project.brief.booths).toBe(3)
    expect(r.project.plans[0].objects.filter((o) => o.type === 'booth')).toHaveLength(3)
  })
})

describe('出力', () => {
  it('4種類のシートをSVGにできる', () => {
    const p = withPlans()
    for (const style of ['proposal', 'ops', 'pitch', 'bare'] as const) {
      const svg = sheetToSvg(composeSheet(p, p.plans[0], { style, themeId: 'light' }))
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).not.toContain('NaN')
    }
  })

  it('PowerPointをネイティブ図形で書き出せる', async () => {
    const p = withPlans()
    const pptx = buildPptx(Pptx, p, [p.plans[0]], { styles: ['proposal', 'ops'], themeId: 'noir' })
    const buf = await pptx.write({ outputType: 'nodebuffer' })
    expect(buf.length).toBeGreaterThan(50000)
  })
})
