import { useMemo, useRef, useState } from 'react'
import { aiErrorText, analyzeFloorplan, chatEdit, proposeSpecs } from '../ai/claude'
import { applyAnalysis } from '../core/analysis'
import { CATALOG, ENTRANCE_LABEL, FLOW_LABEL, LAYERS, PALETTE_GROUPS, SEAT, makeObj, objName } from '../core/catalog'
import { norm360, objCenter, ptsBBox } from '../core/geometry'
import { activePlan, applyChatOps, ensurePlan, listObjs, setObjs } from '../core/ops'
import { buildPlan, generatePlans, sanitizeSpec } from '../core/planner'
import { rerouteFlows } from '../core/route'
import { seatBlockers, seatCount, standingCap } from '../core/seats'
import { emptyProject, makeEntrance, rectVenue, rescaleProject, sampleProject, snapEntrance } from '../core/structure'
import { THEME_LIST, getTheme } from '../core/themes'
import type { Brief, EntranceKind, EventType, FlowKind, Obj, ObjType, Plan, Project, SeatingStyle } from '../core/types'
import { uid } from '../core/types'
import { validate } from '../core/validate'
import { readImageFile, readPdfFile, rotate90, saveFile } from '../io/files'
import type { LoadedImage } from '../io/files'
import { exportPdf, exportPng, exportPptx, exportSvg, safeName } from '../render/export'
import { SHEET_STYLES, composeSheet } from '../render/sheet'
import type { SheetStyle } from '../render/sheet'
import { planSvg, sheetToSvg } from '../render/svg'
import { useStore } from '../store'
import { Field, Num, Section, Seg, Toggle } from './bits'
import { viewport } from './Canvas'
import { WarpDialog } from './WarpDialog'

const S = () => useStore.getState()

// ─────────────────────────────────────────────── 図面

function sourceProject(img: LoadedImage, brief: Brief): Project {
  // 縮尺が分かるまでは「画像の横幅 = 30m」と仮定し、会場は画像の少し内側の長方形から始める
  const mmPerPx = 30000 / img.w
  const W = img.w * mmPerPx
  const H = img.h * mmPerPx
  const m = 0.07
  const venue = rectVenue(Math.round(W * (1 - 2 * m)), Math.round(H * (1 - 2 * m)), '会場')
  return {
    v: 1,
    name: img.name.replace(/\.[^.]+$/, ''),
    source: { name: img.name, kind: img.kind, dataUrl: img.dataUrl, wPx: img.w, hPx: img.h, mmPerPx, x: -W * m, y: -H * m, opacity: 0.55, scaleKnown: false, texts: img.texts },
    venue,
    structure: [],
    brief,
    plans: [],
    activePlan: null,
  }
}

export function SourcePanel() {
  const project = useStore((s) => s.project)
  const mode = useStore((s) => s.mode)
  const ai = useStore((s) => s.ai)
  const aiReady = useStore((s) => s.aiReady)
  const calib = useStore((s) => s.calib)
  const layers = useStore((s) => s.layers)
  const sel = useStore((s) => s.sel)
  const fileRef = useRef<HTMLInputElement>(null)
  const [pdf, setPdf] = useState<{ file: File; pages: number; page: number } | null>(null)
  const [warp, setWarp] = useState(false)
  const [calLen, setCalLen] = useState(10000)
  const [over, setOver] = useState(false)
  const src = project.source
  const bb = ptsBBox(project.venue.outline)

  const useImage = (img: LoadedImage) => {
    S().replace(sourceProject(img, S().project.brief))
    S().setMode('structure')
    S().fit()
  }
  const onFile = async (file: File | undefined | null, page = 1) => {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    S().set({ busy: { label: isPdf ? 'PDFを読み込んでいます' : '画像を読み込んでいます' } })
    try {
      const img = isPdf ? await readPdfFile(file, page) : await readImageFile(file)
      useImage(img)
      setPdf(isPdf && (img.pages || 1) > 1 ? { file, pages: img.pages || 1, page } : null)
      S().toast('図面を読み込みました。会場の形を合わせましょう', 'ok')
    } catch (e: any) {
      S().toast(e?.message || 'ファイルを読み込めませんでした。PDF・PNG・JPEG に対応しています', 'error')
    } finally {
      S().set({ busy: null })
    }
  }
  const analyze = async () => {
    const cur = S().project.source
    if (!cur) return
    const ctl = new AbortController()
    S().set({ busy: { label: 'AIが図面を読み取っています', detail: '30秒〜2分ほどかかります', abort: () => ctl.abort() } })
    try {
      const raw = await analyzeFloorplan(cur, ctl.signal, (n) => S().set({ busy: { label: 'AIが図面を読み取っています', detail: `回答を受信中（${n}文字）`, abort: () => ctl.abort() } }))
      S().replace(applyAnalysis(S().project, raw))
      S().setMode('structure')
      S().fit()
      S().toast('読み取りました。確認事項を見て、ずれていれば直してください', 'ok')
    } catch (e: any) {
      S().toast(aiErrorText(e), e?.code === 'cancelled' ? 'info' : 'error')
    } finally {
      S().set({ busy: null })
    }
  }
  const startCalib = () => {
    S().setMode('structure')
    S().set({ calib: { a: { x: bb.x, y: bb.y + bb.h / 2 }, b: { x: bb.x + bb.w, y: bb.y + bb.h / 2 } } })
  }
  const applyScale = (k: number) => {
    if (!isFinite(k) || k <= 0) return
    S().commit((p) => {
      const r = rescaleProject(p, k)
      return { ...r, sample: false, plans: Math.abs(k - 1) > 0.01 ? [] : r.plans, activePlan: Math.abs(k - 1) > 0.01 ? null : r.activePlan, source: r.source ? { ...r.source, scaleKnown: true } : null }
    })
    S().set({ calib: null })
    S().fit()
    S().toast('縮尺を合わせました。配置案は新しい寸法で作り直してください', 'ok')
  }
  const addStruct = (type: ObjType, kind?: EntranceKind) => {
    S().setMode('structure')
    const cx = Math.min(bb.x + bb.w, Math.max(bb.x, viewport.cx))
    const cy = Math.min(bb.y + bb.h, Math.max(bb.y, viewport.cy))
    const o = type === 'entrance' ? makeEntrance(S().project.venue, { x: cx, y: cy }, kind === 'loading' ? 3000 : 1800, kind || 'entrance') : { ...makeObj(type, cx, cy), id: uid('s') }
    S().commit((p) => ({ ...p, sample: false, structure: [...p.structure, o] }))
    S().select([o.id])
  }
  const selObj = mode === 'structure' && sel.length === 1 ? project.structure.find((s) => s.id === sel[0]) : undefined

  return (
    <div className="pane">
      {project.sample && <p className="note">サンプル会場を表示しています。自分の図面を読み込むと置き換わります。</p>}
      <Section title="図面を読み込む">
        <div
          className={`drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void onFile(e.dataTransfer.files?.[0]) }}
        >
          <p><strong>PDF・画像・写真</strong>をここに置くか、ファイルを選んでください</p>
          <button type="button" className="btn primary" onClick={() => fileRef.current?.click()}>ファイルを選ぶ</button>
          <input ref={fileRef} id="file-source" type="file" accept="application/pdf,image/*" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
        </div>
        {src && (
          <div className="src-card">
            <img src={src.dataUrl} alt="読み込んだ元図面" />
            <div className="src-meta">
              <strong>{src.name}</strong>
              <span>{src.kind === 'pdf' ? 'PDF' : src.kind === 'photo' ? '写真（補正済み）' : '画像'}・{src.scaleKnown ? '縮尺確定' : '縮尺未確定'}</span>
              {pdf && (
                <span className="row">
                  ページ
                  <select id="pdf-page" value={pdf.page} onChange={(e) => void onFile(pdf.file, Number(e.target.value))}>
                    {Array.from({ length: pdf.pages }, (_, i) => <option key={i} value={i + 1}>{i + 1} / {pdf.pages}</option>)}
                  </select>
                </span>
              )}
            </div>
          </div>
        )}
        {src && (
          <>
            <Field label="元図面の濃さ" htmlFor="src-op">
              <input id="src-op" type="range" min={0} max={1} step={0.05} value={layers.source.visible ? src.opacity : 0}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  useStore.setState((s) => ({ layers: { ...s.layers, source: { ...s.layers.source, visible: v > 0 } }, project: { ...s.project, source: s.project.source ? { ...s.project.source, opacity: v || s.project.source.opacity } : null } }))
                }} />
            </Field>
            <div className="row wrap">
              <button type="button" className="btn" onClick={() => setWarp(true)}>台形補正</button>
              <button type="button" className="btn" onClick={async () => { const r = await rotate90(src.dataUrl); useImage({ ...r, kind: src.kind, name: src.name, texts: undefined }) }}>90°回転</button>
              <button type="button" className="btn" onClick={() => S().commit((p) => ({ ...p, source: null }))}>図面を外す</button>
            </div>
          </>
        )}
      </Section>

      {src && (
        <Section title="AIで読み取る">
          {ai.sample && ai.images ? (
            <>
              <p className="hint">壁の輪郭・柱・出入口・寸法をAIが読み取り、編集できるデータにします。結果は候補なので、必ず目で確認してください。</p>
              <button type="button" className="btn primary block" onClick={analyze}>AIで図面を読み取る</button>
            </>
          ) : (
            <p className="hint">{aiReady ? 'AIの読み取りは、Claudeの中でこのページを開いたときに使えます。いまは下の「会場の形」で頂点を合わせてください。' : 'AIが使えるか確認しています…'}</p>
          )}
          {!!project.analysis?.notes.length && (
            <ul className="notes">
              {project.analysis.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
        </Section>
      )}

      <Section title="会場の形" aside={<Seg label="編集モード" value={mode} options={[{ id: 'layout', name: '配置' }, { id: 'structure', name: '会場' }]} onChange={(m) => S().setMode(m)} />}>
        <p className="hint">「会場」モードでは、四角い点をドラッグして壁を動かせます。辺の中ほどの丸を押すと頂点が増え、頂点をダブルタップすると消えます。</p>
        <div className="grid2">
          <Field label="横幅" htmlFor="v-w"><Num id="v-w" value={bb.w} scale={1000} unit="m" min={2000} onChange={(v) => applyScale(v / bb.w)} /></Field>
          <Field label="奥行き" htmlFor="v-h"><Num id="v-h" value={bb.h} scale={1000} unit="m" min={2000}
            onChange={(v) => S().commit((p) => {
              const k = v / bb.h
              const venue = { ...p.venue, outline: p.venue.outline.map((q) => ({ x: q.x, y: bb.y + (q.y - bb.y) * k })) }
              return { ...p, sample: false, venue, structure: p.structure.map((o) => (o.type === 'entrance' ? snapEntrance(o, venue) : o)), plans: [], activePlan: null }
            })} /></Field>
        </div>
        <p className="hint">横幅を変えると図面全体の縮尺が変わります。奥行きは形だけを変えます。</p>
        {calib ? (
          <div className="calib">
            <p>ピンクの2点を、実際の長さが分かる2か所に合わせてください。</p>
            <Field label="2点間の実際の長さ" htmlFor="cal-len"><Num id="cal-len" value={calLen} scale={1000} unit="m" min={100} digits={2} onChange={setCalLen} /></Field>
            <div className="row">
              <button type="button" className="btn primary" onClick={() => applyScale(calLen / Math.max(1, Math.hypot(calib.b.x - calib.a.x, calib.b.y - calib.a.y)))}>この長さに合わせる</button>
              <button type="button" className="btn" onClick={() => S().set({ calib: null })}>やめる</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn block" onClick={startCalib}>2点の実寸から縮尺を合わせる</button>
        )}
        <div className="chips" aria-label="会場に追加">
          <button type="button" onClick={() => addStruct('entrance', 'entrance')}>＋入口</button>
          <button type="button" onClick={() => addStruct('entrance', 'exit')}>＋出口</button>
          <button type="button" onClick={() => addStruct('entrance', 'emergency')}>＋非常口</button>
          <button type="button" onClick={() => addStruct('entrance', 'loading')}>＋搬入口</button>
          <button type="button" onClick={() => addStruct('column')}>＋柱</button>
          <button type="button" onClick={() => addStruct('fixed')}>＋固定設備</button>
          <button type="button" onClick={() => addStruct('wall')}>＋内壁</button>
          <button type="button" onClick={() => addStruct('nogo')}>＋使用不可</button>
        </div>
        {selObj && <ObjProps o={selObj} mode="structure" />}
      </Section>

      <Section title="はじめから">
        <div className="row wrap">
          <button type="button" className="btn" onClick={() => { S().replace(emptyProject()); S().setMode('structure'); S().fit() }}>白紙の会場から作る</button>
          <button type="button" className="btn" onClick={() => { const p = sampleProject(); p.plans = generatePlans(p); p.activePlan = p.plans[0].id; S().replace(p); S().setMode('layout'); S().fit() }}>サンプルに戻す</button>
        </div>
      </Section>
      {warp && src && (
        <WarpDialog dataUrl={src.dataUrl} w={src.wPx} h={src.hPx} onClose={() => setWarp(false)} onDone={(r) => { setWarp(false); useImage({ ...r, kind: 'photo', name: src.name }) }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────── 条件

const EVENT_TYPES: { id: EventType; name: string }[] = [
  { id: 'conference', name: 'カンファレンス' },
  { id: 'exhibition', name: '展示会' },
  { id: 'ceremony', name: '式典' },
  { id: 'party', name: 'パーティー' },
  { id: 'live', name: 'ライブ・フェス' },
]
const SEATING: { id: SeatingStyle; name: string }[] = [
  { id: 'auto', name: 'おまかせ' },
  { id: 'theater', name: 'シアター' },
  { id: 'classroom', name: 'スクール' },
  { id: 'round', name: '円卓' },
  { id: 'standing', name: 'スタンディング' },
]

export function makePlans(kind: 'rule' | 'ai') {
  const st = S()
  if (kind === 'rule') {
    st.commit((p) => {
      const plans = generatePlans(p)
      return { ...p, plans: [...plans, ...p.plans.filter((x) => x.origin === 'manual')], activePlan: plans[0]?.id || null }
    })
    st.setMode('layout')
    st.setTab('plans')
    st.toast('3つの配置案を作りました', 'ok')
    return
  }
  const ctl = new AbortController()
  st.set({ busy: { label: 'AIが配置方針を考えています', detail: '20秒〜1分ほどかかります', abort: () => ctl.abort() } })
  proposeSpecs(st.project, ctl.signal)
    .then((raw) => {
      if (!raw.length) throw { code: 'invalid_json' }
      S().commit((p) => {
        const plans = raw.map((r, i) => buildPlan(p, sanitizeSpec(r, p.brief, i), 'ai'))
        return { ...p, plans: [...plans, ...p.plans.filter((x) => x.origin === 'manual')], activePlan: plans[0]?.id || null }
      })
      S().setMode('layout')
      S().setTab('plans')
      S().toast('AIの方針をもとに3案を配置しました', 'ok')
    })
    .catch((e) => S().toast(aiErrorText(e), e?.code === 'cancelled' ? 'info' : 'error'))
    .finally(() => S().set({ busy: null }))
}

export function BriefPanel() {
  const b = useStore((s) => s.project.brief)
  const ai = useStore((s) => s.ai)
  const set = (patch: Partial<Brief>) => S().commit((p) => ({ ...p, brief: { ...p.brief, ...patch } }))
  const seated = b.eventType !== 'live' || b.seatingStyle === 'theater'
  return (
    <div className="pane">
      <Section title="イベント">
        <Field label="タイトル" htmlFor="b-title">
          <input id="b-title" type="text" defaultValue={b.title} key={b.title} onBlur={(e) => e.target.value !== b.title && set({ title: e.target.value })} />
        </Field>
        <Field label="種類" htmlFor="b-type">
          <select id="b-type" value={b.eventType} onChange={(e) => set({ eventType: e.target.value as EventType })}>
            {EVENT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <div className="grid2">
          <Field label="来場者" htmlFor="b-att"><Num id="b-att" value={b.attendees} unit="名" min={1} step={10} onChange={(v) => set({ attendees: Math.round(v) })} /></Field>
          <Field label="受付" htmlFor="b-rec"><Num id="b-rec" value={b.reception} unit="台" min={0} onChange={(v) => set({ reception: Math.round(v) })} /></Field>
        </div>
      </Section>
      <Section title="ステージと客席">
        <Toggle id="b-stage" checked={b.stage} onChange={(v) => set({ stage: v })} label="ステージを置く" />
        <Field label="ステージの位置" htmlFor="b-side">
          <select id="b-side" value={b.stageSide} onChange={(e) => set({ stageSide: e.target.value as Brief['stageSide'] })}>
            <option value="auto">おまかせ（入口の反対側）</option>
            <option value="N">図面の上側の壁</option>
            <option value="S">図面の下側の壁</option>
            <option value="W">図面の左側の壁</option>
            <option value="E">図面の右側の壁</option>
          </select>
        </Field>
        <Field label="客席の形式" htmlFor="b-seat">
          <select id="b-seat" value={b.seatingStyle} onChange={(e) => set({ seatingStyle: e.target.value as SeatingStyle })}>
            {SEATING.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <div className="grid2">
          <Field label={seated ? '客席数' : '着席数'} htmlFor="b-seats"><Num id="b-seats" value={b.seats} unit="席" min={0} step={10} onChange={(v) => set({ seats: Math.round(v) })} /></Field>
          <Field label="来賓席" htmlFor="b-vip"><Num id="b-vip" value={b.vipSeats} unit="席" min={0} onChange={(v) => set({ vipSeats: Math.round(v) })} /></Field>
        </div>
        <div className="checks">
          <Toggle id="b-screen" checked={b.screen} onChange={(v) => set({ screen: v })} label="スクリーン" />
          <Toggle id="b-podium" checked={b.podium} onChange={(v) => set({ podium: v })} label="演台" />
          <Toggle id="b-foh" checked={b.foh} onChange={(v) => set({ foh: v })} label="音響・照明卓" />
          <Toggle id="b-cam" checked={b.camera} onChange={(v) => set({ camera: v })} label="カメラ台" />
        </div>
      </Section>
      <Section title="展示・サービス">
        <div className="grid2">
          <Field label="展示ブース" htmlFor="b-booths"><Num id="b-booths" value={b.booths} unit="小間" min={0} onChange={(v) => set({ booths: Math.round(v) })} /></Field>
          <Field label="小間の大きさ" htmlFor="b-bw">
            <span className="row tight">
              <Num id="b-bw" value={b.boothW} scale={1000} min={1500} max={9000} onChange={(v) => set({ boothW: v })} />
              <span>×</span>
              <Num id="b-bd" value={b.boothD} scale={1000} unit="m" min={1500} max={9000} onChange={(v) => set({ boothD: v })} />
            </span>
          </Field>
          <Field label="飲食" htmlFor="b-food"><Num id="b-food" value={b.food} unit="店" min={0} onChange={(v) => set({ food: Math.round(v) })} /></Field>
          <Field label="物販" htmlFor="b-merch"><Num id="b-merch" value={b.merch} unit="店" min={0} onChange={(v) => set({ merch: Math.round(v) })} /></Field>
        </div>
        <div className="checks">
          <Toggle id="b-staff" checked={b.staff} onChange={(v) => set({ staff: v })} label="スタッフ待機" />
          <Toggle id="b-cloak" checked={b.cloak} onChange={(v) => set({ cloak: v })} label="クローク" />
          <Toggle id="b-aid" checked={b.firstaid} onChange={(v) => set({ firstaid: v })} label="救護" />
          <Toggle id="b-lounge" checked={b.lounge} onChange={(v) => set({ lounge: v })} label="交流ラウンジ" />
        </div>
      </Section>
      <Section title="ルール">
        <Field label="最小通路幅" htmlFor="b-aisle" hint="この幅より狭い通り道はチェックで知らせます。">
          <Num id="b-aisle" value={b.aisleMin} scale={1000} unit="m" min={800} max={3000} step={100} onChange={(v) => set({ aisleMin: v })} />
        </Field>
        <Field label="そのほかの条件" htmlFor="b-notes" hint="AIに配置を考えてもらうときに読み取ります。">
          <textarea id="b-notes" rows={3} defaultValue={b.notes} key={b.notes} onBlur={(e) => e.target.value !== b.notes && set({ notes: e.target.value })} />
        </Field>
      </Section>
      <div className="stick">
        <button type="button" className="btn primary block" onClick={() => makePlans('rule')}>この条件で配置案を作る</button>
        {ai.sample && <button type="button" className="btn block" onClick={() => makePlans('ai')}>AIに方針を考えてもらう</button>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────── 配置案

function PlanCard({ project, plan, active, themeId }: { project: Project; plan: Plan; active: boolean; themeId: string }) {
  const svg = useMemo(() => planSvg(project, plan, getTheme(themeId)), [project.venue, project.structure, plan, themeId]) // eslint-disable-line react-hooks/exhaustive-deps
  const v = useMemo(() => validate(project, plan), [project, plan])
  const err = v.issues.filter((i) => i.sev === 'error').length
  const warn = v.issues.filter((i) => i.sev === 'warn').length
  return (
    <article className={`plan${active ? ' on' : ''}`}>
      <button type="button" className="plan-pick" aria-pressed={active} onClick={() => { S().commit((p) => ({ ...p, activePlan: plan.id })); S().setMode('layout') }}>
        <div className="thumb" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="plan-body">
          <h4><span className="plan-key">{plan.name}</span>{plan.concept}<span className={`badge ${plan.origin}`}>{plan.origin === 'ai' ? 'AI' : plan.origin === 'manual' ? '手動' : 'ルール'}</span></h4>
          {plan.rationale[0] && <p>{plan.rationale[0]}</p>}
          <div className="plan-stats">
            {v.stats.seats > 0 && <span>客席 <b>{v.stats.seats}</b></span>}
            {v.stats.standing > 0 && <span>立ち <b>約{v.stats.standing}</b></span>}
            {v.stats.booths > 0 && <span>ブース <b>{v.stats.booths}</b></span>}
            {err > 0 && <span className="chip error">要修正 {err}</span>}
            {warn > 0 && <span className="chip warn">注意 {warn}</span>}
            {err + warn === 0 && <span className="chip ok">問題なし</span>}
          </div>
        </div>
      </button>
      {active && (
        <div className="plan-acts">
          {plan.rationale.slice(1).map((r, i) => <p key={i} className="why">・{r}</p>)}
          <div className="row">
            <button type="button" className="btn small" onClick={() => S().setTab('edit')}>編集する</button>
            <button type="button" className="btn small" onClick={() => S().commit((p) => { const c: Plan = { ...plan, id: uid('p'), name: `${plan.name}′`, origin: 'manual', objects: plan.objects.map((o) => ({ ...o, id: uid() })) }; return { ...p, plans: [...p.plans, c], activePlan: c.id } })}>複製</button>
            <button type="button" className="btn small" onClick={() => S().commit((p) => { const rest = p.plans.filter((x) => x.id !== plan.id); return { ...p, plans: rest, activePlan: rest[0]?.id || null } })}>削除</button>
          </div>
        </div>
      )}
    </article>
  )
}

export function PlansPanel() {
  const project = useStore((s) => s.project)
  const themeId = useStore((s) => s.themeId)
  const ai = useStore((s) => s.ai)
  const cur = activePlan(project)
  return (
    <div className="pane">
      <div className="row wrap">
        <button type="button" className="btn primary" onClick={() => makePlans('rule')}>配置案を作り直す</button>
        {ai.sample && <button type="button" className="btn" onClick={() => makePlans('ai')}>AIに方針を考えてもらう</button>}
      </div>
      <p className="hint">方針（ステージの向き・客席の形式・ブースの置き方）ごとに、寸法と通路を計算して配置します。案を選ぶと図面に反映され、そのまま編集できます。</p>
      {!project.plans.length && <p className="empty">まだ配置案がありません。「条件」を確認して、配置案を作ってください。</p>}
      <div className="plans">
        {project.plans.map((pl) => <PlanCard key={pl.id} project={project} plan={pl} active={cur?.id === pl.id} themeId={themeId} />)}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────── 編集

const SEAT_STYLES = [
  { id: 'theater', name: 'シアター' },
  { id: 'classroom', name: 'スクール' },
  { id: 'vip', name: '来賓' },
]

export function ObjProps({ o, mode }: { o: Obj; mode: 'layout' | 'structure' }) {
  const project = useStore((s) => s.project)
  const up = (fn: (x: Obj) => Obj) => S().commit((p) => setObjs(p, mode, (l) => l.map((x) => (x.id === o.id ? fn(x) : x))))
  const c = objCenter(o)
  const plan = activePlan(project)
  const env = { blockers: seatBlockers(project.structure, plan?.objects), outline: project.venue.outline }
  const isFlow = o.type === 'flow'
  const isDoor = o.type === 'entrance'
  const setSeat = (rows: number, cols: number, style?: string) =>
    up((x) => {
      const st = (style || x.props?.style || 'theater') as keyof typeof SEAT
      const d = SEAT[st] || SEAT.theater
      const w = cols * d.pitchX
      const h = rows * d.pitchY
      const cc = objCenter(x)
      return { ...x, w, h, x: cc.x - w / 2, y: cc.y - h / 2, props: { ...x.props, style: st, rows, cols } }
    })
  return (
    <div className="props">
      <div className="props-head">
        <strong>{CATALOG[o.type].name}</strong>
        {o.type === 'seat_block' && <span className="pill">{seatCount(o, env)}席</span>}
        {o.type === 'standing' && <span className="pill">約{standingCap(o)}人</span>}
      </div>
      <Field label="名前" htmlFor="p-label">
        <input id="p-label" type="text" defaultValue={o.label || ''} key={o.id + (o.label || '')} placeholder={objName({ ...o, label: undefined })} onBlur={(e) => (e.target.value || '') !== (o.label || '') && up((x) => ({ ...x, label: e.target.value || undefined }))} />
      </Field>
      {!isFlow && (
        <div className="grid2">
          <Field label="中心 X" htmlFor="p-x"><Num id="p-x" value={c.x} scale={1000} unit="m" digits={2} step={100} onChange={(v) => up((x) => (isDoor ? snapEntrance({ ...x, x: v - x.w / 2 }, project.venue) : { ...x, x: v - x.w / 2 }))} /></Field>
          <Field label="中心 Y" htmlFor="p-y"><Num id="p-y" value={c.y} scale={1000} unit="m" digits={2} step={100} onChange={(v) => up((x) => (isDoor ? snapEntrance({ ...x, y: v - x.h / 2 }, project.venue) : { ...x, y: v - x.h / 2 }))} /></Field>
          {o.type !== 'seat_block' && (
            <Field label={isDoor ? '開口幅' : '幅'} htmlFor="p-w"><Num id="p-w" value={o.w} scale={1000} unit="m" digits={2} min={50} step={100} onChange={(v) => up((x) => { const cc = objCenter(x); const n = { ...x, w: v, x: cc.x - v / 2 }; return isDoor ? snapEntrance(n, project.venue) : n })} /></Field>
          )}
          {o.type !== 'seat_block' && !isDoor && (
            <Field label="奥行き" htmlFor="p-h"><Num id="p-h" value={o.h} scale={1000} unit="m" digits={2} min={50} step={100} onChange={(v) => up((x) => { const cc = objCenter(x); return { ...x, h: v, y: cc.y - v / 2 } })} /></Field>
          )}
          {!isDoor && <Field label="回転" htmlFor="p-rot"><Num id="p-rot" value={o.rot} unit="°" step={15} onChange={(v) => up((x) => ({ ...x, rot: norm360(v) }))} /></Field>}
        </div>
      )}
      {o.type === 'seat_block' && (
        <>
          <Field label="形式" htmlFor="p-style">
            <select id="p-style" value={o.props?.style || 'theater'} onChange={(e) => setSeat(o.props?.rows || 1, o.props?.cols || 1, e.target.value)}>
              {SEAT_STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <div className="grid2">
            <Field label="行（前後）" htmlFor="p-rows"><Num id="p-rows" value={o.props?.rows || 1} min={1} max={80} onChange={(v) => setSeat(Math.round(v), o.props?.cols || 1)} /></Field>
            <Field label={o.props?.style === 'classroom' ? '机の数（横）' : '列（横）'} htmlFor="p-cols"><Num id="p-cols" value={o.props?.cols || 1} min={1} max={80} onChange={(v) => setSeat(o.props?.rows || 1, Math.round(v))} /></Field>
          </div>
        </>
      )}
      {o.type === 'round_table' && <Field label="席数" htmlFor="p-seats"><Num id="p-seats" value={o.props?.seats ?? 10} unit="席" min={2} max={14} onChange={(v) => up((x) => ({ ...x, props: { ...x.props, seats: Math.round(v) } }))} /></Field>}
      {o.type === 'table' && <Field label="席数" htmlFor="p-tseats"><Num id="p-tseats" value={o.props?.seats ?? 0} unit="席" min={0} max={20} onChange={(v) => up((x) => ({ ...x, h: v > 0 && x.h < 1500 ? 1700 : x.h, props: { ...x.props, seats: Math.round(v) } }))} /></Field>}
      {o.type === 'standing' && <Field label="密度の目安" htmlFor="p-dens"><Num id="p-dens" value={o.props?.density ?? 1.5} unit="人/㎡" digits={1} min={0.3} max={5} step={0.1} onChange={(v) => up((x) => ({ ...x, props: { ...x.props, density: v } }))} /></Field>}
      {o.type === 'booth' && <Field label="小間番号" htmlFor="p-no"><Num id="p-no" value={Number(o.props?.no) || 0} min={0} onChange={(v) => up((x) => ({ ...x, props: { ...x.props, no: Math.round(v) || undefined } }))} /></Field>}
      {isDoor && (
        <Field label="種類" htmlFor="p-kind">
          <select id="p-kind" value={o.props?.kind || 'entrance'} onChange={(e) => up((x) => ({ ...x, props: { ...x.props, kind: e.target.value } }))}>
            {(Object.keys(ENTRANCE_LABEL) as EntranceKind[]).map((k) => <option key={k} value={k}>{ENTRANCE_LABEL[k]}</option>)}
          </select>
        </Field>
      )}
      {isFlow && (
        <>
          <Field label="種類" htmlFor="p-fkind">
            <select id="p-fkind" value={o.props?.kind || 'visitor'} onChange={(e) => up((x) => ({ ...x, props: { ...x.props, kind: e.target.value } }))}>
              {(Object.keys(FLOW_LABEL) as FlowKind[]).map((k) => <option key={k} value={k}>{FLOW_LABEL[k]}</option>)}
            </select>
          </Field>
          <p className="hint">白い丸をドラッグして経路を変えられます。途中の青い丸で折れ点を追加、ダブルタップで削除。</p>
        </>
      )}
      {o.type === 'column' && <Toggle id="p-round" checked={!!o.props?.round} onChange={(v) => up((x) => ({ ...x, props: { ...x.props, round: v } }))} label="丸柱" />}
      <div className="row wrap">
        <label className="color" htmlFor="p-color">
          色
          <input id="p-color" type="color" value={o.color || '#808080'} onChange={(e) => up((x) => ({ ...x, color: e.target.value }))} />
        </label>
        {o.color && <button type="button" className="btn small" onClick={() => up((x) => ({ ...x, color: undefined }))}>色を戻す</button>}
        <Toggle id="p-lock" checked={!!o.locked} onChange={(v) => up((x) => ({ ...x, locked: v }))} label="固定" />
      </div>
    </div>
  )
}

function ChatBox() {
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [running, setRunning] = useState(false)
  const ctl = useRef<AbortController | null>(null)
  const run = async (cmd: string) => {
    const st = S()
    const plan = activePlan(st.project)
    if (!cmd.trim() || !plan || running) return
    ctl.current = new AbortController()
    setRunning(true)
    setReply('考えています…')
    try {
      const res = await chatEdit(st.project, plan, cmd.trim(), ctl.current.signal)
      const r = applyChatOps(S().project, res.ops)
      if (r.applied) {
        S().commit(() => r.project)
        const v = validate(r.project, activePlan(r.project))
        const bad = v.issues.filter((i) => i.sev === 'error').length
        setReply(`${res.reply || `${r.applied}件の変更を反映しました。`}${bad ? ` ／ 要修正が${bad}件あります（チェックで確認できます）` : ''}`)
        setText('')
      } else setReply(res.reply || '変更できる内容が見つかりませんでした。言い方を変えて試してください。')
    } catch (e: any) {
      setReply(aiErrorText(e))
    } finally {
      setRunning(false)
    }
  }
  const examples = ['受付を入口の右側に移動して', 'ステージを20%大きく', '客席をスクール形式に', '展示ブースを8小間に']
  return (
    <Section title="言葉で編集">
      <div className="chat">
        <textarea id="chat-cmd" rows={2} placeholder="例：受付を入口の右側に移動して" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run(text) }} />
        <div className="row">
          <button type="button" className="btn primary" disabled={running || !text.trim()} onClick={() => void run(text)}>{running ? '実行中…' : 'AIに指示する'}</button>
          {running && <button type="button" className="btn" onClick={() => ctl.current?.abort()}>止める</button>}
        </div>
        <div className="chips">
          {examples.map((x) => <button key={x} type="button" disabled={running} onClick={() => setText(x)}>{x}</button>)}
        </div>
        {reply && <p className="reply" aria-live="polite">{reply}</p>}
      </div>
    </Section>
  )
}

export function EditPanel() {
  const project = useStore((s) => s.project)
  const mode = useStore((s) => s.mode)
  const sel = useStore((s) => s.sel)
  const layers = useStore((s) => s.layers)
  const snap = useStore((s) => s.snap)
  const ai = useStore((s) => s.ai)
  const plan = activePlan(project)
  const list = listObjs(project, mode).filter((o) => sel.includes(o.id))
  const add = (type: ObjType) => {
    S().setMode('layout')
    const o = makeObj(type, viewport.cx, viewport.cy, type === 'booth' ? { props: { no: (plan?.objects.filter((x) => x.type === 'booth').reduce((a, x) => Math.max(a, Number(x.props?.no) || 0), 0) || 0) + 1 } } : {})
    S().commit((p) => setObjs(ensurePlan(p), 'layout', (l) => [...l, o]))
    if (!S().layers[CATALOG[type].layer].visible) S().toggleLayer(CATALOG[type].layer, 'visible')
    S().select([o.id])
  }
  return (
    <div className="pane">
      {mode === 'structure' && (
        <p className="note">いまは「会場」モードです。<button type="button" className="link" onClick={() => S().setMode('layout')}>配置の編集に戻る</button></p>
      )}
      {ai.sample && plan && <ChatBox />}
      {list.length === 1 && mode === 'layout' && (
        <Section title="選択中">
          <ObjProps o={list[0]} mode="layout" />
        </Section>
      )}
      {list.length > 1 && <p className="note">{list.length}個を選択中。ドラッグでまとめて動かせます。</p>}
      <Section title="追加する">
        {PALETTE_GROUPS.map((g) => (
          <div key={g.name} className="pal">
            <span className="pal-name">{g.name}</span>
            <div className="chips">
              {g.types.map((t) => <button key={t} type="button" onClick={() => add(t)}>{CATALOG[t].name}</button>)}
            </div>
          </div>
        ))}
        <p className="hint">画面の中央に追加されます。ドラッグで移動、角のハンドルで大きさと向きを変えられます。</p>
      </Section>
      <Section title="表示とスナップ">
        <ul className="layers">
          {LAYERS.map((l) => (
            <li key={l.id}>
              <span>{l.name}</span>
              <button type="button" className={`tiny${layers[l.id].visible ? ' on' : ''}`} aria-pressed={layers[l.id].visible} onClick={() => S().toggleLayer(l.id, 'visible')}>{layers[l.id].visible ? '表示' : '非表示'}</button>
              {l.id !== 'source' && l.id !== 'structure' && (
                <button type="button" className={`tiny${layers[l.id].locked ? ' on' : ''}`} aria-pressed={layers[l.id].locked} onClick={() => S().toggleLayer(l.id, 'locked')}>{layers[l.id].locked ? '固定中' : '編集可'}</button>
              )}
            </li>
          ))}
        </ul>
        <Field label="グリッドに吸着" htmlFor="e-snap">
          <select id="e-snap" value={snap} onChange={(e) => S().set({ snap: Number(e.target.value) })}>
            <option value={0}>なし</option>
            <option value={50}>5cm</option>
            <option value={100}>10cm</option>
            <option value={250}>25cm</option>
            <option value={500}>50cm</option>
            <option value={1000}>1m</option>
          </select>
        </Field>
        {plan && <button type="button" className="btn block" onClick={() => { S().commit((p) => setObjs(p, 'layout', () => rerouteFlows(p, activePlan(p) as Plan))); S().toast('いまの配置に合わせて動線を引き直しました', 'ok') }}>動線を引き直す</button>}
      </Section>
    </div>
  )
}

// ─────────────────────────────────────────────── チェック

const SEV_LABEL = { error: '要修正', warn: '注意', info: 'メモ', ok: 'OK' }

export function CheckPanel() {
  const project = useStore((s) => s.project)
  const plan = activePlan(project)
  const { issues, stats } = useMemo(() => validate(project, plan), [project, plan])
  return (
    <div className="pane">
      <div className="tiles">
        <div><span>会場面積</span><b>{Math.round(stats.areaM2)}<i>㎡</i></b></div>
        <div><span>客席</span><b>{stats.seats}<i>席</i></b></div>
        <div><span>スタンディング</span><b>{stats.standing ? `約${stats.standing}` : '—'}<i>{stats.standing ? '人' : ''}</i></b></div>
        <div><span>展示ブース</span><b>{stats.booths || '—'}<i>{stats.booths ? '小間' : ''}</i></b></div>
        <div><span>最遠席→出口</span><b>{stats.maxExitDistM ? `約${Math.round(stats.maxExitDistM)}` : '—'}<i>{stats.maxExitDistM ? 'm' : ''}</i></b></div>
        <div><span>来場者1人あたり</span><b>{project.brief.attendees ? (stats.areaM2 / project.brief.attendees).toFixed(1) : '—'}<i>㎡</i></b></div>
      </div>
      <Section title="確認事項">
        {!plan && <p className="empty">配置案を作ると、重なり・通路幅・出入口・収容をチェックします。</p>}
        <ul className="issues">
          {issues.map((i) => (
            <li key={i.id} className={i.sev}>
              <button type="button" disabled={!i.ids.length} onClick={() => { S().setMode('layout'); S().focus(i.ids) }}>
                <span className={`chip ${i.sev}`}>{SEV_LABEL[i.sev]}</span>
                <span className="issue-text"><strong>{i.title}</strong>{i.detail && <em>{i.detail}</em>}</span>
              </button>
            </li>
          ))}
        </ul>
        {plan && !issues.some((i) => i.sev === 'error' || i.sev === 'warn') && <p className="okline">重なり・通路幅・出入口まわりに問題は見つかっていません。</p>}
      </Section>
      <p className="hint">ここでの判定は幾何計算による確認の補助です。避難・防災・定員は、法令と施設の規定、消防との協議で確定してください。</p>
    </div>
  )
}

// ─────────────────────────────────────────────── 出力

export function ExportPanel() {
  const project = useStore((s) => s.project)
  const themeId = useStore((s) => s.themeId)
  const plan = activePlan(project)
  const [styles, setStyles] = useState<SheetStyle[]>(['proposal', 'ops', 'pitch'])
  const [all, setAll] = useState(false)
  const [withSource, setWithSource] = useState(false)
  const [preview, setPreview] = useState<SheetStyle>('proposal')
  const openRef = useRef<HTMLInputElement>(null)
  const svg = useMemo(() => (plan ? sheetToSvg(composeSheet(project, plan, { style: preview, themeId, withSource: withSource && !!project.source })) : ''), [project, plan, preview, themeId, withSource])
  const plans = all ? project.plans : plan ? [plan] : []
  const base = safeName(project.brief.title || project.name)
  const wrap = async (label: string, fn: () => Promise<{ name: string; data: Blob | string }>) => {
    if (!plans.length) return S().toast('先に配置案を作ってください', 'error')
    if (!styles.length) return S().toast('出力するスライドの種類を1つ以上選んでください', 'error')
    S().set({ busy: { label: `${label}を作っています` } })
    try {
      const f = await fn()
      const r = await saveFile(f.name, f.data)
      if (r === 'saved') S().toast(`${f.name} を書き出しました`, 'ok')
      else if (r === 'failed') S().toast('保存できませんでした。Claudeの中で開いているか確認して、もう一度試してください', 'error')
    } catch (e: any) {
      S().toast(`${label}を作れませんでした（${e?.message || '不明なエラー'}）`, 'error')
    } finally {
      S().set({ busy: null })
    }
  }
  const toggle = (id: SheetStyle) => setStyles((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const ordered = SHEET_STYLES.map((s) => s.id).filter((id) => styles.includes(id))
  const openProject = async (file?: File | null) => {
    if (!file) return
    try {
      const p = JSON.parse(await file.text()) as Project
      if (p?.v !== 1 || !Array.isArray(p.venue?.outline) || p.venue.outline.length < 3) throw new Error('形式が違います')
      S().replace(p)
      S().fit()
      S().toast('プロジェクトを開きました', 'ok')
    } catch {
      S().toast('このファイルは開けませんでした。Event Floorplan AI のプロジェクトファイル（.json）を選んでください', 'error')
    }
  }
  return (
    <div className="pane">
      <Section title="プレビュー" aside={<Seg label="プレビューの種類" value={preview} options={SHEET_STYLES.map((s) => ({ id: s.id, name: s.name.replace('スタッフ', '') }))} onChange={setPreview} />}>
        {plan ? <div className="sheet-prev" dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="empty">配置案を作ると、出力イメージが表示されます。</p>}
      </Section>
      <Section title="スライドの種類">
        <ul className="styles">
          {SHEET_STYLES.map((s) => (
            <li key={s.id}>
              <Toggle id={`st-${s.id}`} checked={styles.includes(s.id)} onChange={() => toggle(s.id)} label={s.name} />
              <span>{s.desc}</span>
            </li>
          ))}
        </ul>
        <Field label="図面のテーマ" htmlFor="x-theme">
          <select id="x-theme" value={themeId} onChange={(e) => S().set({ themeId: e.target.value })}>
            {THEME_LIST.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <div className="checks one">
          <Toggle id="x-all" checked={all} onChange={setAll} label={`すべての案を入れる（${project.plans.length}案）`} />
          {project.source && <Toggle id="x-src" checked={withSource} onChange={setWithSource} label="元図面を下敷きにする" />}
        </div>
      </Section>
      <Section title="書き出す">
        <button type="button" className="btn primary block big" onClick={() => wrap('PowerPoint', async () => ({ name: `${base}.pptx`, data: await exportPptx(project, plans, { styles: ordered, themeId, withSource }) }))}>PowerPoint（.pptx）</button>
        <p className="hint">壁・柱・ステージ・席・ブース・矢印・文字を、PowerPointの図形として1つずつ書き出します。PowerPoint上でそのまま動かしたり色を変えたりできます。</p>
        <div className="row wrap">
          <button type="button" className="btn" onClick={() => wrap('PDF', async () => ({ name: `${base}.pdf`, data: await exportPdf(project, plans, ordered, themeId, withSource) }))}>PDF</button>
          <button type="button" className="btn" onClick={() => wrap('PNG', async () => ({ name: `${base}_${preview}.png`, data: await exportPng(project, plan as Plan, { style: preview, themeId, withSource }) }))}>PNG（表示中の種類）</button>
          <button type="button" className="btn" onClick={() => wrap('SVG', async () => ({ name: `${base}_${preview}.svg`, data: new Blob([exportSvg(project, plan as Plan, { style: preview, themeId, withSource })], { type: 'image/svg+xml' }) }))}>SVG（表示中の種類）</button>
        </div>
      </Section>
      <Section title="プロジェクト">
        <p className="hint">編集内容はこのブラウザに自動保存されます。ほかの端末で続けるときや、手元に残すときはファイルに保存してください。</p>
        <div className="row wrap">
          <button type="button" className="btn" onClick={async () => { const r = await saveFile(`${base}.json`, new Blob([JSON.stringify(project)], { type: 'application/json' })); if (r === 'saved') S().toast('プロジェクトを保存しました', 'ok'); else if (r === 'failed') S().toast('保存できませんでした', 'error') }}>プロジェクトを保存（.json）</button>
          <button type="button" className="btn" onClick={() => openRef.current?.click()}>プロジェクトを開く</button>
          <input ref={openRef} id="file-project" type="file" accept="application/json,.json" hidden onChange={(e) => { void openProject(e.target.files?.[0]); e.target.value = '' }} />
        </div>
      </Section>
    </div>
  )
}
