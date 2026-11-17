// Event Floorplan AI — data model
// 内部座標はすべて mm。原点は会場バウンディングボックスの左上、x→右、y→下。

export type Pt = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

export type ObjType =
  // 演出・進行
  | 'stage' | 'screen' | 'podium' | 'foh' | 'camera'
  // 客席
  | 'seat_block' | 'round_table' | 'table' | 'standing'
  // 展示
  | 'booth'
  // 受付・サービス
  | 'reception' | 'cloak' | 'lounge' | 'queue'
  // 飲食・物販
  | 'food' | 'merch'
  // スタッフ・安全
  | 'staff' | 'backstage' | 'firstaid'
  // 仕切り・その他
  | 'partition' | 'barricade' | 'generic' | 'label'
  // ゾーン・動線
  | 'zone' | 'flow'
  // 会場構造（structure レイヤー）
  | 'column' | 'entrance' | 'fixed' | 'wall' | 'nogo'

export type LayerId = 'source' | 'structure' | 'zone' | 'seating' | 'furniture' | 'flow' | 'note'

export type Cat =
  | 'production' | 'seating' | 'exhibit' | 'service' | 'fnb'
  | 'staff' | 'safety' | 'zone' | 'flow' | 'note' | 'structure'

export type EntranceKind = 'entrance' | 'exit' | 'emergency' | 'loading'
export type FlowKind = 'visitor' | 'load' | 'evac' | 'staff'

/** 図面上の1オブジェクト。x,y は回転前ボックスの左上、rot は中心まわりの時計回り(度)。 */
export interface Obj {
  id: string
  type: ObjType
  label?: string
  x: number
  y: number
  w: number
  h: number
  rot: number
  color?: string
  locked?: boolean
  hidden?: boolean
  // 種別ごとの追加属性（seat_block: rows/cols/style, booth: no, flow: pts/kind など）
  props?: Record<string, any>
}

export interface SourceImage {
  name: string
  kind: 'image' | 'pdf' | 'photo'
  dataUrl: string
  wPx: number
  hPx: number
  /** 1px が何mmか。縮尺合わせで更新される */
  mmPerPx: number
  /** 画像左上の会場座標(mm) */
  x: number
  y: number
  opacity: number
  /** 基準寸法で縮尺を確定済みか */
  scaleKnown: boolean
  /** PDFから抜いたテキスト（AI解析の補助） */
  texts?: { s: string; x: number; y: number }[]
}

export interface Venue {
  name: string
  /** 内壁の輪郭（時計回り, mm） */
  outline: Pt[]
  /** 壁の描画厚(mm) */
  wallT: number
}

export type EventType = 'conference' | 'exhibition' | 'ceremony' | 'party' | 'live'
export type SeatingStyle = 'auto' | 'theater' | 'classroom' | 'round' | 'standing' | 'none'
export type Side = 'N' | 'E' | 'S' | 'W'

export interface Brief {
  title: string
  eventType: EventType
  attendees: number
  stage: boolean
  stageSide: 'auto' | Side
  seatingStyle: SeatingStyle
  seats: number
  vipSeats: number
  reception: number
  booths: number
  boothW: number
  boothD: number
  aisleMin: number
  screen: boolean
  podium: boolean
  foh: boolean
  camera: boolean
  staff: boolean
  cloak: boolean
  firstaid: boolean
  lounge: boolean
  food: number
  merch: number
  /** 自由記述の条件（AI配置で解釈） */
  notes: string
}

export interface ExtraReq {
  type: ObjType
  label?: string
  count: number
  near: 'entrance' | 'stage' | 'rear' | 'rear-corner' | 'side' | 'center' | 'exit' | 'loading'
  w?: number
  h?: number
}

/** 配置エンジンへの指示書。ルール生成もAI生成もこの形に落として幾何エンジンが正確に配置する。 */
export interface LayoutSpec {
  key: string
  name: string
  concept: string
  rationale: string[]
  stageSide: 'opposite' | 'alt' | Side
  stage: { on: boolean; scale: number }
  seating: { style: Exclude<SeatingStyle, 'auto'>; count: number; centerAisle: boolean }
  vip: number
  side: { use: 'none' | 'booths' | 'lounge' | 'fnb' | 'mix'; ratio: number; at: 'entrance' | 'far' }
  booths: { count: number; w: number; d: number; mode: 'wall' | 'grid' | 'perimeter' | 'side'; mainAisle?: number }
  reception: number
  extras: ExtraReq[]
}

export interface Plan {
  id: string
  name: string
  concept: string
  rationale: string[]
  origin: 'rule' | 'ai' | 'manual'
  objects: Obj[]
  /** 生成時の注意（置ききれなかった数など） */
  notes: string[]
  spec?: LayoutSpec
}

export interface Analysis {
  at: string
  notes: string[]
  confidence: Record<string, number>
  venueName?: string
}

export interface Project {
  v: 1
  name: string
  sample?: boolean
  source: SourceImage | null
  venue: Venue
  /** 会場構造：柱・出入口・固定設備・内壁・使用不可エリア */
  structure: Obj[]
  brief: Brief
  plans: Plan[]
  activePlan: string | null
  analysis?: Analysis
}

export type Severity = 'error' | 'warn' | 'info' | 'ok'
export interface Issue {
  id: string
  sev: Severity
  code: string
  title: string
  detail?: string
  ids: string[]
}

export interface PlanStats {
  areaM2: number
  seats: number
  standing: number
  capacity: number
  booths: number
  reception: number
  objects: number
  maxExitDistM: number | null
}

let _n = 0
export function uid(prefix = 'o'): string {
  _n += 1
  return `${prefix}${Date.now().toString(36).slice(-4)}${_n.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}
