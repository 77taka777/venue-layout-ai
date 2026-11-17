import { useEffect, useMemo } from 'react'
import { aiStatus } from './ai/claude'
import { activePlan } from './core/ops'
import { THEME_LIST } from './core/themes'
import { validate } from './core/validate'
import { restore, useStore } from './store'
import type { TabId } from './store'
import { Seg } from './ui/bits'
import { Canvas } from './ui/Canvas'
import { BriefPanel, CheckPanel, EditPanel, ExportPanel, PlansPanel, SourcePanel } from './ui/panels'

const TABS: { id: TabId; name: string }[] = [
  { id: 'source', name: '図面' },
  { id: 'brief', name: '条件' },
  { id: 'plans', name: '配置案' },
  { id: 'edit', name: '編集' },
  { id: 'check', name: 'チェック' },
  { id: 'export', name: '出力' },
]

export default function App() {
  const tab = useStore((s) => s.tab)
  const panelOpen = useStore((s) => s.panelOpen)
  const mode = useStore((s) => s.mode)
  const themeId = useStore((s) => s.themeId)
  const busy = useStore((s) => s.busy)
  const toasts = useStore((s) => s.toasts)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const project = useStore((s) => s.project)
  const plan = activePlan(project)
  const problems = useMemo(() => validate(project, plan).issues.filter((i) => i.sev === 'error' || i.sev === 'warn').length, [project, plan])

  useEffect(() => {
    void restore()
    void aiStatus().then((ai) => useStore.setState({ ai, aiReady: true }))
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const st = useStore.getState()
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        st.redo()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        st.duplicateSelected()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.sel.length) {
          e.preventDefault()
          st.removeSelected()
        }
      } else if (e.key === 'Escape') st.select([])
      else if (e.key.startsWith('Arrow') && st.sel.length) {
        e.preventDefault()
        const d = (st.snap || 100) * (e.shiftKey ? 5 : 1)
        st.nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const st = useStore.getState()
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span className="brand-name">Event Floorplan AI</span>
        </div>
        <div className="doc">
          <strong>{project.brief.title || project.name}</strong>
          <span>{plan ? `${plan.name}｜${plan.concept}` : '配置案なし'}</span>
        </div>
        <div className="top-actions">
          <Seg label="編集モード" value={mode} options={[{ id: 'layout', name: '配置' }, { id: 'structure', name: '会場' }]} onChange={(m) => st.setMode(m)} />
          <button type="button" className="icon-btn" aria-label="元に戻す" title="元に戻す" disabled={!canUndo} onClick={() => st.undo()}>↶</button>
          <button type="button" className="icon-btn" aria-label="やり直す" title="やり直す" disabled={!canRedo} onClick={() => st.redo()}>↷</button>
          <label className="theme-pick" htmlFor="top-theme">
            <span>図面テーマ</span>
            <select id="top-theme" value={themeId} onChange={(e) => st.set({ themeId: e.target.value })}>
              {THEME_LIST.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn primary" onClick={() => st.setTab('export')}>出力</button>
        </div>
      </header>
      <main className="work" data-open={panelOpen}>
        <section className="stage" aria-label="図面">
          <Canvas />
        </section>
        <aside className="panel">
          <nav className="tabs" aria-label="作業の流れ">
            {TABS.map((t, i) => (
              <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => (tab === t.id && panelOpen ? st.set({ panelOpen: false }) : st.setTab(t.id))}>
                <span className="step">{i + 1}</span>
                {t.name}
                {t.id === 'check' && problems > 0 && <span className="count">{problems}</span>}
              </button>
            ))}
            <button type="button" className="fold" aria-label={panelOpen ? 'パネルをたたむ' : 'パネルをひらく'} onClick={() => st.set({ panelOpen: !panelOpen })}>{panelOpen ? '▾' : '▴'}</button>
          </nav>
          <div className="panel-body">
            {tab === 'source' && <SourcePanel />}
            {tab === 'brief' && <BriefPanel />}
            {tab === 'plans' && <PlansPanel />}
            {tab === 'edit' && <EditPanel />}
            {tab === 'check' && <CheckPanel />}
            {tab === 'export' && <ExportPanel />}
          </div>
        </aside>
      </main>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            <button type="button" aria-label="閉じる" onClick={() => st.dismissToast(t.id)}>×</button>
          </div>
        ))}
      </div>
      {busy && (
        <div className="busy" role="status">
          <div className="busy-card">
            <span className="spin" aria-hidden="true" />
            <div>
              <strong>{busy.label}</strong>
              {busy.detail && <p>{busy.detail}</p>}
            </div>
            {busy.abort && <button type="button" className="btn" onClick={busy.abort}>中止</button>}
          </div>
        </div>
      )}
    </div>
  )
}
