import type { Cat, EntranceKind, FlowKind, LayerId, Obj, ObjType } from './types'
import { uid } from './types'

export interface CatalogItem {
  type: ObjType
  name: string
  cat: Cat
  w: number
  h: number
  /** 重なり・通路チェックの対象になる実体か */
  solid: boolean
  layer: LayerId
  z: number
  unit: string
  /** パレットに出すか */
  palette?: boolean
  props?: Record<string, any>
}

const C = (i: CatalogItem) => i

export const CATALOG: Record<ObjType, CatalogItem> = {
  stage: C({ type: 'stage', name: 'ステージ', cat: 'production', w: 7200, h: 3600, solid: true, layer: 'furniture', z: 7, unit: '基', palette: true }),
  screen: C({ type: 'screen', name: 'スクリーン', cat: 'production', w: 5000, h: 150, solid: true, layer: 'furniture', z: 8, unit: '面', palette: true }),
  podium: C({ type: 'podium', name: '演台', cat: 'production', w: 900, h: 600, solid: false, layer: 'furniture', z: 9, unit: '台', palette: true }),
  foh: C({ type: 'foh', name: '音響・照明卓', cat: 'production', w: 2400, h: 1500, solid: true, layer: 'furniture', z: 8, unit: '卓', palette: true }),
  camera: C({ type: 'camera', name: 'カメラ台', cat: 'production', w: 1500, h: 1500, solid: true, layer: 'furniture', z: 8, unit: '台', palette: true }),

  seat_block: C({ type: 'seat_block', name: '客席ブロック', cat: 'seating', w: 5000, h: 4750, solid: true, layer: 'seating', z: 5, unit: '席', palette: true, props: { style: 'theater', rows: 5, cols: 10 } }),
  round_table: C({ type: 'round_table', name: '円卓', cat: 'seating', w: 2800, h: 2800, solid: true, layer: 'seating', z: 5, unit: '卓', palette: true, props: { seats: 10 } }),
  table: C({ type: 'table', name: 'テーブル', cat: 'seating', w: 1800, h: 750, solid: true, layer: 'seating', z: 5, unit: '台', palette: true, props: { seats: 0 } }),
  standing: C({ type: 'standing', name: 'スタンディング', cat: 'seating', w: 8000, h: 6000, solid: false, layer: 'seating', z: 1, unit: 'エリア', palette: true, props: { density: 1.5 } }),

  booth: C({ type: 'booth', name: '展示ブース', cat: 'exhibit', w: 3000, h: 3000, solid: true, layer: 'furniture', z: 6, unit: '小間', palette: true }),

  reception: C({ type: 'reception', name: '受付', cat: 'service', w: 1800, h: 1100, solid: true, layer: 'furniture', z: 8, unit: '台', palette: true }),
  cloak: C({ type: 'cloak', name: 'クローク', cat: 'service', w: 3000, h: 1500, solid: true, layer: 'furniture', z: 8, unit: '箇所', palette: true }),
  lounge: C({ type: 'lounge', name: '交流ラウンジ', cat: 'service', w: 6000, h: 4000, solid: false, layer: 'furniture', z: 1, unit: 'エリア', palette: true }),
  queue: C({ type: 'queue', name: '待機列', cat: 'service', w: 4000, h: 2400, solid: false, layer: 'furniture', z: 1, unit: '箇所', palette: true }),

  food: C({ type: 'food', name: '飲食', cat: 'fnb', w: 3000, h: 2000, solid: true, layer: 'furniture', z: 8, unit: '店', palette: true }),
  merch: C({ type: 'merch', name: '物販', cat: 'fnb', w: 3000, h: 2000, solid: true, layer: 'furniture', z: 8, unit: '店', palette: true }),

  staff: C({ type: 'staff', name: 'スタッフ待機', cat: 'staff', w: 3600, h: 3000, solid: true, layer: 'furniture', z: 8, unit: '箇所', palette: true }),
  backstage: C({ type: 'backstage', name: '控室・袖', cat: 'staff', w: 3000, h: 3000, solid: true, layer: 'furniture', z: 8, unit: '箇所', palette: true }),
  firstaid: C({ type: 'firstaid', name: '救護', cat: 'safety', w: 3000, h: 2400, solid: true, layer: 'furniture', z: 8, unit: '箇所', palette: true }),

  partition: C({ type: 'partition', name: 'パーティション', cat: 'note', w: 3600, h: 100, solid: true, layer: 'furniture', z: 9, unit: '枚', palette: true }),
  barricade: C({ type: 'barricade', name: '柵・バリケード', cat: 'safety', w: 6000, h: 150, solid: true, layer: 'furniture', z: 9, unit: '本', palette: true }),
  generic: C({ type: 'generic', name: '什器（自由）', cat: 'note', w: 2000, h: 1500, solid: true, layer: 'furniture', z: 8, unit: '個', palette: true }),
  label: C({ type: 'label', name: '文字ラベル', cat: 'note', w: 3000, h: 800, solid: false, layer: 'note', z: 21, unit: '個', palette: true }),

  zone: C({ type: 'zone', name: 'ゾーン', cat: 'zone', w: 8000, h: 6000, solid: false, layer: 'zone', z: 0, unit: 'エリア', palette: true }),
  flow: C({ type: 'flow', name: '動線', cat: 'flow', w: 6000, h: 100, solid: false, layer: 'flow', z: 20, unit: '本', palette: true, props: { kind: 'visitor' } }),

  column: C({ type: 'column', name: '柱', cat: 'structure', w: 600, h: 600, solid: true, layer: 'structure', z: 3, unit: '本' }),
  entrance: C({ type: 'entrance', name: '出入口', cat: 'structure', w: 1800, h: 400, solid: false, layer: 'structure', z: 4, unit: '箇所', props: { kind: 'entrance' } }),
  fixed: C({ type: 'fixed', name: '固定設備', cat: 'structure', w: 4000, h: 3000, solid: true, layer: 'structure', z: 2, unit: '箇所' }),
  wall: C({ type: 'wall', name: '内壁', cat: 'structure', w: 4000, h: 150, solid: true, layer: 'structure', z: 3, unit: '枚' }),
  nogo: C({ type: 'nogo', name: '使用不可エリア', cat: 'structure', w: 3000, h: 3000, solid: true, layer: 'structure', z: 2, unit: '箇所' }),
}

export const PALETTE_GROUPS: { name: string; types: ObjType[] }[] = [
  { name: '演出', types: ['stage', 'screen', 'podium', 'foh', 'camera'] },
  { name: '客席', types: ['seat_block', 'round_table', 'table', 'standing'] },
  { name: '展示・受付', types: ['booth', 'reception', 'cloak', 'lounge', 'queue'] },
  { name: '飲食・運営', types: ['food', 'merch', 'staff', 'backstage', 'firstaid'] },
  { name: 'その他', types: ['partition', 'barricade', 'generic', 'label', 'zone', 'flow'] },
]

export const STRUCTURE_TYPES: ObjType[] = ['column', 'entrance', 'fixed', 'wall', 'nogo']

export const ENTRANCE_LABEL: Record<EntranceKind, string> = {
  entrance: '入口',
  exit: '出口',
  emergency: '非常口',
  loading: '搬入口',
}

export const FLOW_LABEL: Record<FlowKind, string> = {
  visitor: '来場者動線',
  load: '搬入動線',
  evac: '避難動線',
  staff: 'スタッフ動線',
}

export const CAT_LABEL: Record<Cat, string> = {
  production: '演出・進行',
  seating: '客席',
  exhibit: '展示',
  service: '受付・サービス',
  fnb: '飲食・物販',
  staff: 'スタッフ',
  safety: '安全・救護',
  zone: 'ゾーン',
  flow: '動線',
  note: 'その他',
  structure: '会場構造',
}

export const LAYERS: { id: LayerId; name: string }[] = [
  { id: 'source', name: '元図面' },
  { id: 'structure', name: '会場構造' },
  { id: 'zone', name: 'ゾーン' },
  { id: 'seating', name: '客席' },
  { id: 'furniture', name: '什器・設備' },
  { id: 'flow', name: '動線' },
  { id: 'note', name: 'ラベル' },
]

export const cat = (o: Obj): CatalogItem => CATALOG[o.type] || CATALOG.generic
export const isSolid = (o: Obj) => cat(o).solid && !o.hidden
export const layerOf = (o: Obj): LayerId => cat(o).layer
export const objName = (o: Obj): string => {
  if (o.label) return o.label
  if (o.type === 'entrance') return ENTRANCE_LABEL[(o.props?.kind as EntranceKind) || 'entrance']
  if (o.type === 'flow') return FLOW_LABEL[(o.props?.kind as FlowKind) || 'visitor']
  return cat(o).name
}

// 客席ブロックの標準寸法
export const SEAT = {
  theater: { pitchX: 500, pitchY: 950, seatW: 440, seatD: 460 },
  classroom: { pitchX: 1800, pitchY: 1500, tableD: 450, seatW: 440, seatD: 440, perTable: 3 },
  vip: { pitchX: 650, pitchY: 1100, seatW: 560, seatD: 540 },
}

export function seatProps(o: Obj) {
  const style: 'theater' | 'classroom' | 'vip' = o.props?.style || 'theater'
  const d = SEAT[style] || SEAT.theater
  return { style, ...d }
}

/** 新しいオブジェクトを既定サイズで作る（中心 cx,cy） */
export function makeObj(type: ObjType, cx: number, cy: number, patch: Partial<Obj> = {}): Obj {
  const c = CATALOG[type]
  let w = patch.w ?? c.w
  let h = patch.h ?? c.h
  const props = { ...(c.props || {}), ...(patch.props || {}) }
  if (type === 'seat_block') {
    const sp = SEAT[(props.style as 'theater') || 'theater'] || SEAT.theater
    w = props.cols * sp.pitchX
    h = props.rows * sp.pitchY
  }
  const o: Obj = { id: uid(), type, x: cx - w / 2, y: cy - h / 2, w, h, rot: 0, ...patch, props }
  o.w = w
  o.h = h
  if (patch.x === undefined) o.x = cx - w / 2
  if (patch.y === undefined) o.y = cy - h / 2
  if (type === 'flow' && !props.pts) {
    o.props = { ...props, pts: [cx - 3000, cy, cx, cy, cx + 3000, cy] }
  }
  return o
}
