// 幾何チェック。LLMに任せず、プログラムで重複・干渉・通路・入口・収容・避難距離を確認する。
// 避難・防災・収容人数は法令・施設規定・消防協議が必要なため、ここでの判定は確認の補助。
import { CATALOG, ENTRANCE_LABEL, isSolid, objName } from './catalog'
import {
  G_BLOCK, G_INSIDE, autoCell, bfs, cellAt, makeGrid, objAABB, objCenter, objCorners, objGap, objInsidePoly,
  polyArea, ptsBBox, rad, rasterObj, rasterPoly, rectsOverlap,
} from './geometry'
import { doorClearance, seatBlockers, seatCount, standingCap } from './seats'
import type { EntranceKind, Issue, Obj, Plan, PlanStats, Project } from './types'

const m = (mm: number) => (mm / 1000).toFixed(1)
const NO_AISLE = new Set(['podium', 'screen', 'partition', 'barricade'])
const ROW_TYPES = new Set(['booth', 'reception', 'food', 'merch', 'table'])

export function validate(project: Project, plan: Plan | null): { issues: Issue[]; stats: PlanStats } {
  const issues: Issue[] = []
  const outline = project.venue.outline
  const brief = project.brief
  const objs = plan ? plan.objects.filter((o) => !o.hidden) : []
  const solids = objs.filter(isSolid)
  const struct = project.structure.filter((s) => !s.hidden)
  const structSolids = struct.filter(isSolid)
  const env = { blockers: seatBlockers(project.structure, plan ? plan.objects : null), outline }
  const island = (a: Obj, b: Obj) => (a.type === 'seat_block' && (b.type === 'foh' || b.type === 'camera')) || (b.type === 'seat_block' && (a.type === 'foh' || a.type === 'camera'))
  let n = 0
  const add = (sev: Issue['sev'], code: string, title: string, detail: string | undefined, ids: string[]) =>
    issues.push({ id: `${code}${n++}`, sev, code, title, detail, ids })

  // 縮尺
  if (project.source && !project.source.scaleKnown) {
    add('warn', 'scale', '縮尺が未確定です', '「図面」タブで基準寸法を入れると、通路幅や収容人数の判定が実寸になります。', [])
  }

  // 会場外・構造との干渉
  for (const o of solids) {
    if (!objInsidePoly(o, outline, 80)) add('error', 'outside', `${objName(o)}が会場の外にはみ出しています`, undefined, [o.id])
    for (const s of structSolids) {
      if (o.type === 'seat_block' && s.type === 'column') continue
      if (!rectsOverlap(objAABB(o), objAABB(s))) continue
      if (objGap(o, s) < -30) add('error', 'struct', `${objName(o)}が${objName(s)}と干渉しています`, undefined, [o.id])
    }
  }

  // オブジェクトどうしの重なり
  const overlapPairs: [Obj, Obj][] = []
  for (let i = 0; i < solids.length; i++) {
    const a = solids[i]
    const ba = objAABB(a)
    for (let j = i + 1; j < solids.length; j++) {
      const b = solids[j]
      if (!rectsOverlap(ba, objAABB(b)) || island(a, b)) continue
      if (objGap(a, b) < -30) overlapPairs.push([a, b])
    }
  }
  for (const [a, b] of overlapPairs.slice(0, 12)) add('error', 'overlap', `${objName(a)}と${objName(b)}が重なっています`, undefined, [a.id, b.id])
  if (overlapPairs.length > 12) add('error', 'overlap', `ほかに ${overlapPairs.length - 12} 件の重なりがあります`, undefined, overlapPairs.slice(12).flatMap(([a, b]) => [a.id, b.id]))

  // 出入口の前
  const doors = struct.filter((s) => s.type === 'entrance')
  for (const d of doors) {
    const r = rad(d.rot || 0)
    const nx = -Math.sin(r)
    const ny = Math.cos(r)
    const c = objCenter(d)
    const depth = 1800
    const clr = { x: c.x + nx * (depth / 2 + 100) - (d.w + 200) / 2, y: c.y + ny * (depth / 2 + 100) - depth / 2, w: d.w + 200, h: depth, rot: d.rot } as Obj
    // 客席ブロックは出入口の前の席を自動で間引くので対象外
    const hit = solids.filter((o) => o.type !== 'seat_block' && rectsOverlap(objAABB(o), objAABB(clr)) && objGap(o, clr) < -30)
    if (hit.length) {
      const kind = ENTRANCE_LABEL[(d.props?.kind as EntranceKind) || 'entrance']
      add('error', 'door', `${d.label || kind}の前がふさがっています`, `${hit.map(objName).slice(0, 3).join('・')} を ${m(depth)}m 以上離してください。`, hit.map((o) => o.id))
    }
  }
  const exits = doors.filter((d) => d.props?.kind !== 'loading')
  if (!doors.length) add('warn', 'nodoor', '出入口が設定されていません', '「図面」タブの会場編集で入口・非常口を追加すると、導線と避難のチェックができます。', [])
  else if (exits.length < 2 && brief.attendees >= 50) add('warn', 'exits', '避難に使える出入口が1か所のみです', '2方向避難が取れるか、施設の図面で確認してください。', exits.map((d) => d.id))

  // 通路幅（向かい合う面どうしの隙間）
  const aisleMin = brief.aisleMin || 1200
  const narrow = new Map<string, { gap: number; a: Obj; b: Obj; count: number }>()
  for (let i = 0; i < solids.length; i++) {
    const a = solids[i]
    if (NO_AISLE.has(a.type)) continue
    const A = objAABB(a)
    for (let j = i + 1; j < solids.length; j++) {
      const b = solids[j]
      if (NO_AISLE.has(b.type)) continue
      const B = objAABB(b)
      const dx = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w))
      const dy = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h))
      // 片方向だけ離れている＝面が向かい合っている
      if (dx > 0 === dy > 0) continue
      const gap = Math.max(dx, dy)
      // 450mm 未満は「並べて置いている」とみなし、通路としては数えない
      if (gap < 450 || gap >= aisleMin - 20 || island(a, b)) continue
      if (a.type === 'round_table' && b.type === 'round_table') continue
      const key = [a.type, b.type].sort().join('|')
      const cur = narrow.get(key)
      if (!cur) narrow.set(key, { gap, a, b, count: 1 })
      else {
        cur.count++
        if (gap < cur.gap) { cur.gap = gap; cur.a = a; cur.b = b }
      }
    }
  }
  for (const v of narrow.values()) {
    add('warn', 'aisle', `通路幅 ${m(v.gap)}m（${CATALOG[v.a.type].name} × ${CATALOG[v.b.type].name}）`, `最小通路幅 ${m(aisleMin)}m を下回っています${v.count > 1 ? `（ほか ${v.count - 1} か所）` : ''}。`, [v.a.id, v.b.id])
  }

  // 収容
  let seats = 0
  let standing = 0
  let booths = 0
  let reception = 0
  let count = 0
  for (const o of objs) {
    if (o.type === 'zone' || o.type === 'flow' || o.type === 'label') continue
    count++
    seats += seatCount(o, env)
    if (o.type === 'standing') standing += standingCap(o)
    if (o.type === 'booth') booths++
    if (o.type === 'reception') reception++
  }
  const areaM2 = polyArea(outline) / 1e6
  const capacity = seats + standing
  if (plan) {
    const wantSeats = plan.spec ? (plan.spec.seating.style === 'standing' || plan.spec.seating.style === 'none' ? 0 : plan.spec.seating.count) : brief.seats
    if (wantSeats > 0) {
      if (seats < wantSeats) add('warn', 'seats', `客席 ${seats}席（要件 ${wantSeats}席）`, 'ステージの縮小、通路幅の見直し、別の案の検討で席数を増やせます。', [])
      else add('ok', 'seats', `客席 ${seats}席（要件 ${wantSeats}席）`, undefined, [])
    }
    if (capacity > 0 && capacity < brief.attendees && wantSeats === 0) add('warn', 'cap', `収容の目安 ${capacity}人（来場 ${brief.attendees}人）`, 'スタンディングは密度の目安から算出しています。', [])
    if (brief.booths > 0) {
      if (booths < brief.booths) add('warn', 'booths', `展示ブース ${booths}小間（要件 ${brief.booths}小間）`, undefined, [])
      else add('ok', 'booths', `展示ブース ${booths}小間（要件 ${brief.booths}小間）`, undefined, [])
    }
    if (brief.attendees > 0 && areaM2 / brief.attendees < 1.0) {
      add('warn', 'density', `1人あたり ${(areaM2 / brief.attendees).toFixed(2)}㎡`, '会場面積に対して来場者数が多めです。同時滞在人数と施設の定員を確認してください。', [])
    }
  }

  // 到達可能性と避難距離（グリッドBFS）
  let maxExitDistM: number | null = null
  if (plan && exits.length) {
    const bb = ptsBBox(outline)
    const cell = autoCell(bb, 180)
    const g = makeGrid(bb, cell)
    rasterPoly(g, outline, G_INSIDE)
    const grow = Math.max(0, 300 - cell / 2)
    for (const s of solids) if (s.type === 'seat_block') rasterObj(g, s, G_BLOCK, grow)
    for (const d of exits) rasterPoly(g, objCorners(doorClearance(d, 2000)), G_BLOCK, true)
    for (const s of [...structSolids, ...solids]) if (s.type !== 'seat_block') rasterObj(g, s, G_BLOCK, grow)
    const pass = (i: number) => (g.data[i] & G_INSIDE) !== 0 && (g.data[i] & G_BLOCK) === 0
    const src: number[] = []
    for (const d of exits) {
      const r = rad(d.rot || 0)
      const c = objCenter(d)
      for (const t of [500, 900, 1400, 2000]) src.push(cellAt(g, c.x - Math.sin(r) * t, c.y + Math.cos(r) * t))
    }
    const dist = bfs(g, pass, src)
    const reach = (o: Obj): number => {
      // 外周を少し外側でサンプリングして、いちばん近い到達セルの距離を返す
      const cs = objCorners(o, grow + cell * 1.6)
      let best = -1
      for (let k = 0; k < 4; k++) {
        const a = cs[k]
        const b = cs[(k + 1) % 4]
        const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell * 2)))
        for (let s = 0; s <= steps; s++) {
          const x = a.x + ((b.x - a.x) * s) / steps
          const y = a.y + ((b.y - a.y) * s) / steps
          if (x < bb.x || y < bb.y || x > bb.x + bb.w || y > bb.y + bb.h) continue
          const d = dist[cellAt(g, x, y)]
          if (d >= 0 && (best < 0 || d < best)) best = d
        }
      }
      return best
    }
    const targets = solids.filter((o) => !NO_AISLE.has(o.type) && o.type !== 'foh' && o.type !== 'camera')
    const unreachable: Obj[] = []
    let far = 0
    for (const o of targets) {
      const d = reach(o)
      if (d < 0) unreachable.push(o)
      else if (o.type === 'seat_block' || o.type === 'round_table' || o.type === 'table') far = Math.max(far, d * cell + Math.max(o.w, o.h) / 2)
    }
    for (const o of objs.filter((x) => x.type === 'standing')) {
      const d = reach(o)
      if (d >= 0) far = Math.max(far, d * cell + Math.max(o.w, o.h) / 2)
    }
    if (unreachable.length) {
      add('warn', 'reach', `通路からたどり着けない設備が ${unreachable.length} 件あります`, `${unreachable.slice(0, 4).map(objName).join('・')} のまわりに 0.6m 以上の通り道がありません。`, unreachable.map((o) => o.id))
    }
    if (far > 0) {
      maxExitDistM = Math.round(far / 100) / 10
      add('info', 'evac', `最遠の客席から出口まで 約${maxExitDistM.toFixed(0)}m`, '什器を避けた歩行距離の目安です。施設・消防の基準で確認してください。', [])
    }
  }

  if (plan) for (const note of plan.notes) add('info', 'note', note, undefined, [])

  const order = { error: 0, warn: 1, info: 2, ok: 3 }
  issues.sort((a, b) => order[a.sev] - order[b.sev])
  return { issues, stats: { areaM2, seats, standing, capacity, booths, reception, objects: count, maxExitDistM } }
}
