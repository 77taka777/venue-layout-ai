// AI連携。Claudeの中で開いているときだけ使える（閲覧者自身のClaudeで動く）。
// 役割は3つ：①図面の読み取り ②配置方針の立案 ③言葉での編集。座標の確定や検証はプログラム側が行う。
import type { AnalysisRaw } from '../core/analysis'
import { CATALOG } from '../core/catalog'
import { chatState } from '../core/ops'
import { venueInfo } from '../core/planner'
import type { Plan, Project, SourceImage } from '../core/types'
import { aiImages, capability } from '../io/files'

type SampleFn = ((input: any, opts?: any) => Promise<{ text: string; truncated: boolean }>) & {
  json: (input: any, opts?: any) => Promise<any>
  limits: () => Promise<{ images?: { maxCount: number } }>
}

export interface AiStatus {
  sample: boolean
  images: boolean
}

let cached: SampleFn | null | undefined

export async function getSample(): Promise<SampleFn | null> {
  if (cached !== undefined) return cached
  cached = await capability<SampleFn>('sample')
  return cached
}

export async function aiStatus(): Promise<AiStatus> {
  const s = await getSample()
  if (!s) return { sample: false, images: false }
  try {
    const lim = await s.limits()
    return { sample: true, images: !!lim?.images }
  } catch {
    return { sample: true, images: false }
  }
}

export function aiErrorText(e: any): string {
  switch (e?.code) {
    case 'cancelled': return '中止しました'
    case 'not_granted': return 'AIの利用が許可されませんでした'
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed': return 'この画面ではAIを利用できません'
    case 'images_unavailable': return 'この画面では画像をAIに送れません'
    case 'image_rejected': return '画像を送れませんでした。別のファイルで試してください'
    case 'rate_limited': return 'AIの利用が混み合っています。少し待ってからもう一度試してください'
    case 'session_expired': return 'サインインし直してから、もう一度試してください'
    case 'refused': return 'AIがこの内容には答えられませんでした。内容を変えて試してください'
    case 'invalid_json':
    case 'empty_completion': return 'AIの回答をうまく読み取れませんでした。もう一度試してください'
    case 'prompt_too_large': return '送る内容が大きすぎます。図面や条件を減らしてください'
    default: return 'AIとの通信に失敗しました。もう一度試してください'
  }
}

// ── ① 図面の読み取り ──────────────────────────────────────────

const ANALYZE = `あなたはイベント会場の平面図（PDF・画像・写真）を読み取る解析器です。
添付画像は同じ図面です。1枚目は元の図面、2枚目は座標の目盛りを赤いグリッドで重ねたものです（目盛りは横 0〜1000、縦 0〜1000。左上が 0,0）。
座標はすべてこの 0〜1000 の値で答えてください。x は左→右、y は上→下です。

読み取るもの:
- outline: イベントに使えるメインの部屋（ホール・宴会場・展示場など最も広い1室）の内壁の輪郭。頂点を時計回りに。長方形なら4点、L字なら6点。壁の内側の線に合わせる。
- columns: 部屋の中にある柱。{x,y,w,h}（x,y は左上）。
- openings: 部屋の出入口・扉・シャッター。壁上の開口の両端 {x1,y1,x2,y2} と kind（entrance=来場者の入口 / exit=出口 / emergency=非常口 / loading=搬入口）。図面の表記（「非常口」「搬入口」「EXIT」など）があれば label に入れる。来場者が主に使う扉が分からなければ、ホワイエ・ロビー側の最も大きい扉を entrance にする。
- fixed: 部屋の中にあって動かせないもの（固定ステージ・倉庫・控室の張り出し・階段・PS など）。{label,x,y,w,h}
- scale: 図面に寸法の記載（例「30,000」「18.5m」）があり、その寸法が指す2点が分かる場合だけ {x1,y1,x2,y2,length_mm,evidence}。なければ null。推測で作らない。
- estimated_width_m: 寸法の記載がない場合に、扉の幅（片開き約0.9m、両開き約1.8m）や椅子・人の大きさから推定した outline の横幅(m)。
- venue_name: 図面に書かれた会場名・室名（なければ空文字）。
- notes: 読み取りに自信がない点、人が確認すべき点を日本語で短く。最大6件。
- confidence: outline / columns / openings / scale それぞれ 0〜1。

読み取れないものは空配列にし、存在しないものを作らないでください。
回答は次の形の JSON だけにしてください（説明文なし）:
{"venue_name":"","outline":[[x,y],...],"columns":[{"x":0,"y":0,"w":0,"h":0}],"openings":[{"kind":"entrance","x1":0,"y1":0,"x2":0,"y2":0,"label":""}],"fixed":[{"label":"","x":0,"y":0,"w":0,"h":0}],"scale":null,"estimated_width_m":0,"notes":[""],"confidence":{"outline":0,"columns":0,"openings":0,"scale":0}}`

export async function analyzeFloorplan(src: SourceImage, signal: AbortSignal, onText?: (chars: number) => void): Promise<AnalysisRaw> {
  const sample = await getSample()
  if (!sample) throw { code: 'capability_disabled' }
  const lim = await sample.limits().catch(() => null)
  if (!lim?.images) throw { code: 'images_unavailable' }
  const { plain, grid } = await aiImages(src.dataUrl)
  const images = lim.images.maxCount >= 2 ? [plain, grid] : [grid]
  let prompt = ANALYZE
  if (lim.images.maxCount < 2) prompt = prompt.replace('添付画像は同じ図面です。1枚目は元の図面、2枚目は座標の目盛りを赤いグリッドで重ねたものです', '添付画像は図面に座標の目盛りを赤いグリッドで重ねたものです')
  if (src.texts?.length) {
    prompt += `\n\n参考: PDFから抜き出した文字と位置（同じ 0〜1000 座標）:\n${src.texts.slice(0, 160).map((t) => `${t.s} @(${t.x},${t.y})`).join('\n')}`
  }
  return (await sample.json(prompt, { images, modelTier: 'complex', signal, cache: false, onText: onText ? (u: { text: string }) => onText(u.text.length) : undefined })) as AnalysisRaw
}

// ── ② 配置方針の立案 ──────────────────────────────────────────

const r1 = (mm: number) => Math.round(mm / 100) / 10

export async function proposeSpecs(project: Project, signal: AbortSignal, onText?: (chars: number) => void): Promise<any[]> {
  const sample = await getSample()
  if (!sample) throw { code: 'capability_disabled' }
  const info = venueInfo(project)
  const b = project.brief
  const types = Object.values(CATALOG)
    .filter((c) => c.layer !== 'structure' && !['zone', 'flow', 'label', 'seat_block', 'round_table', 'stage', 'booth', 'reception'].includes(c.type))
    .map((c) => `${c.type}(${c.name})`)
    .join(', ')
  const prompt = `あなたはイベントの会場レイアウトを設計するプランナーです。会場と条件から、性格の違う配置方針を3案考えてください。
あなたが決めるのは「方針」だけです。実際の座標・寸法・通路幅・重なりの確認はプログラムが行います。

会場（単位 m。左上が原点、x は右、y は下。N=図面の上側の壁, S=下側, W=左, E=右）:
${JSON.stringify({
    bbox: { w: r1(info.bbox.w), h: r1(info.bbox.h) },
    main_rect: { x: r1(info.R.x), y: r1(info.R.y), w: r1(info.R.w), h: r1(info.R.h) },
    outline: project.venue.outline.map((p) => [r1(p.x), r1(p.y)]),
    entrances: info.entrances.map((e) => ({ kind: e.kind, wall: e.side, x: r1(e.c.x), y: r1(e.c.y), width: r1(e.o.w) })),
    columns: project.structure.filter((s) => s.type === 'column').length,
    fixed: project.structure.filter((s) => s.type === 'fixed' || s.type === 'nogo').map((s) => ({ name: s.label || s.type, x: r1(s.x), y: r1(s.y), w: r1(s.w), h: r1(s.h) })),
  })}

イベントの条件:
${JSON.stringify({
    title: b.title, eventType: b.eventType, attendees: b.attendees, stage: b.stage, stageSide: b.stageSide, seatingStyle: b.seatingStyle, seats: b.seats, vipSeats: b.vipSeats,
    reception: b.reception, booths: b.booths, booth_size_m: [r1(b.boothW), r1(b.boothD)], aisleMin_m: r1(b.aisleMin),
    want: { screen: b.screen, podium: b.podium, foh: b.foh, camera: b.camera, staff: b.staff, cloak: b.cloak, firstaid: b.firstaid, lounge: b.lounge, food: b.food, merch: b.merch },
  })}
自由記述の条件（最優先で反映）: ${b.notes || '（なし）'}

各案は次の項目で指定します:
- name: 案の名前（12文字以内） / concept: ねらいを1文で / rationale: この配置にした理由を2〜3個（各40文字以内。会場や条件に即して具体的に）
- stageSide: "opposite"（メイン入口の反対側の壁）/ "alt"（それとは別向き）/ "N" "E" "S" "W"（壁を指定）
- stage: {on, scale}（scale はステージの大きさ倍率 0.5〜1.6）
- seating: {style: "theater"|"classroom"|"round"|"standing"|"none", count, centerAisle}
- vip: 来賓席の数（シアター形式のとき最前列に配置）
- side: {use: "none"|"booths"|"lounge"|"fnb"|"mix", ratio: 0.15〜0.45, at: "entrance"|"far"}（会場の片側に取る帯。展示・交流・飲食に使う）
- booths: {count, mode: "wall"(壁沿い)|"side"(サイド帯)|"grid"(島型)|"perimeter"(外周), mainAisle?: メイン通路幅mm}
- reception: 受付の台数
- extras: 追加で置くもの [{type, label?, count, near: "entrance"|"stage"|"rear"|"rear-corner"|"side"|"center"|"exit"|"loading", w?, h?}]（w,h は mm）。type は次から: ${types}

3案は、席数重視・交流重視・導線重視など、ねらいがはっきり違うものにしてください。条件で数が指定されているものは、理由がない限りその数を守ってください。
回答は JSON だけ: {"plans":[{"name":"","concept":"","rationale":[""],"stageSide":"opposite","stage":{"on":true,"scale":1},"seating":{"style":"theater","count":300,"centerAisle":true},"vip":0,"side":{"use":"none","ratio":0.25,"at":"entrance"},"booths":{"count":0,"mode":"wall"},"reception":3,"extras":[]}]}`
  const res = await sample.json(prompt, { modelTier: 'default', signal, cache: false, onText: onText ? (u: { text: string }) => onText(u.text.length) : undefined })
  const plans = Array.isArray(res?.plans) ? res.plans : Array.isArray(res) ? res : []
  return plans.slice(0, 3)
}

// ── ③ 言葉での編集 ────────────────────────────────────────────

export async function chatEdit(project: Project, plan: Plan, command: string, signal: AbortSignal): Promise<{ ops: any[]; reply: string }> {
  const sample = await getSample()
  if (!sample) throw { code: 'capability_disabled' }
  const prompt = `あなたはイベント平面図エディタの編集アシスタントです。利用者の指示を、図面への操作のリストに変換してください。

現在の図面（JSON。長さは m、位置 cx,cy はオブジェクトの中心、rot は時計回りの角度）:
${chatState(project, plan)}

使える操作:
- {"op":"update","id":"…","cx":数,"cy":数,"w":数,"h":数,"rot":数,"label":"…","scale":倍率}  必要な項目だけ。客席ブロック(seat_block)は "rows","cols","style"("theater"|"classroom"|"vip") で変える。円卓は "seats"。
- {"op":"move","id":"…","dx":数,"dy":数}  相対移動（m）
- {"op":"add","type":"…","cx":数,"cy":数,"w":数,"h":数,"rot":数,"label":"…"}  type は ${Object.values(CATALOG).filter((c) => c.layer !== 'structure').map((c) => c.type).join(', ')}
- {"op":"remove","id":"…"}
- {"op":"replan","brief":{…},"spec":{…}}  席数・ブース数・客席形式・ステージ位置など、全体を作り直したほうが早い変更に使う。brief には attendees, seats, vipSeats, reception, booths, food, merch, seatingStyle("theater"|"classroom"|"round"|"standing"), stageSide("N"|"E"|"S"|"W"), stage, foh, camera, staff, cloak, firstaid, lounge などの変更点だけを入れる。

ルール:
- 「入口の右側」などの左右は、図面を見たときの左右（x が大きいほうが右）で解釈する。
- オブジェクトは会場の輪郭の内側に置き、ほかの什器・柱と重ねない。通路は ${r1(project.brief.aisleMin)}m 以上あける。
- 数を増やす指示は、既存の並びに揃えて add するか、replan を使う。
- 指示があいまいなときは、最も自然な解釈で実行し、reply でどう解釈したかを1文で伝える。
- 実行できない指示は ops を空にして、reply に理由を書く。

利用者の指示: ${command}

回答は JSON だけ: {"ops":[…],"reply":"行ったことを日本語で1〜2文"}`
  const res = await sample.json(prompt, { modelTier: 'default', signal, cache: false })
  return { ops: Array.isArray(res?.ops) ? res.ops : [], reply: typeof res?.reply === 'string' ? res.reply.slice(0, 300) : '' }
}
