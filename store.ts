import { create } from 'zustand'
import type { AiStatus } from './ai/claude'
import { activePlan, duplicate, ensurePlan, listObjs, moveObj, setObjs } from './core/ops'
import type { Mode } from './core/ops'
import { generatePlans } from './core/planner'
import { sampleProject } from './core/structure'
import type { LayerId, Obj, Project, Pt } from './core/types'
import { idbGet, idbSet } from './io/files'

export type TabId = 'source' | 'brief' | 'plans' | 'edit' | 'check' | 'export'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'ok' | 'error'
}

export interface Busy {
  label: string
  detail?: string
  abort?: () => void
}

interface State {
  project: Project
  past: Project[]
  future: Project[]
  sel: string[]
  mode: Mode
  tab: TabId
  panelOpen: boolean
  themeId: string
  layers: Record<LayerId, { visible: boolean; locked: boolean }>
  snap: number
  fitTick: number
  focusIds: string[]
  toasts: Toast[]
  busy: Busy | null
  ai: AiStatus
  aiReady: boolean
  calib: { a: Pt; b: Pt } | null
  loaded: boolean

  commit: (fn: (p: Project) => Project, opts?: { keepSel?: boolean }) => void
  replace: (p: Project) => void
  undo: () => void
  redo: () => void
  select: (ids: string[], additive?: boolean) => void
  setMode: (m: Mode) => void
  setTab: (t: TabId) => void
  set: (patch: Partial<State>) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  fit: () => void
  focus: (ids: string[]) => void
  removeSelected: () => void
  duplicateSelected: () => void
  nudge: (dx: number, dy: number) => void
  toggleLayer: (id: LayerId, key: 'visible' | 'locked') => void
}

function initial(): Project {
  const p = sampleProject()
  p.plans = generatePlans(p)
  p.activePlan = p.plans[0]?.id || null
  return p
}

let toastId = 1

export const useStore = create<State>((set, get) => ({
  project: initial(),
  past: [],
  future: [],
  sel: [],
  mode: 'layout',
  tab: 'plans',
  panelOpen: true,
  themeId: 'light',
  layers: {
    source: { visible: true, locked: true },
    structure: { visible: true, locked: true },
    zone: { visible: false, locked: true },
    seating: { visible: true, locked: false },
    furniture: { visible: true, locked: false },
    flow: { visible: true, locked: false },
    note: { visible: true, locked: false },
  },
  snap: 100,
  fitTick: 0,
  focusIds: [],
  toasts: [],
  busy: null,
  ai: { sample: false, images: false },
  aiReady: false,
  calib: null,
  loaded: false,

  commit: (fn, opts) => {
    const cur = get().project
    const next = fn(cur)
    if (next === cur) return
    const ids = new Set(listObjs(next, get().mode).map((o) => o.id))
    set({
      project: next,
      past: [...get().past.slice(-79), cur],
      future: [],
      sel: opts?.keepSel === false ? [] : get().sel.filter((id) => ids.has(id)),
    })
  },
  replace: (p) => set({ project: p, past: [...get().past.slice(-79), get().project], future: [], sel: [], calib: null }),
  undo: () => {
    const { past, project, future } = get()
    if (!past.length) return
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future].slice(0, 80), sel: [] })
  },
  redo: () => {
    const { past, project, future } = get()
    if (!future.length) return
    set({ project: future[0], future: future.slice(1), past: [...past, project].slice(-80), sel: [] })
  },
  select: (ids, additive) => {
    if (!additive) return set({ sel: ids })
    const cur = new Set(get().sel)
    for (const id of ids) {
      if (cur.has(id)) cur.delete(id)
      else cur.add(id)
    }
    set({ sel: [...cur] })
  },
  setMode: (m) => {
    if (m === 'layout') set({ mode: m, sel: [], calib: null })
    else set({ mode: m, sel: [] })
  },
  setTab: (t) => set({ tab: t, panelOpen: true }),
  set: (patch) => set(patch),
  toast: (text, kind = 'info') => {
    const id = toastId++
    set({ toasts: [...get().toasts.slice(-2), { id, text, kind }] })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4200)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  fit: () => set({ fitTick: get().fitTick + 1 }),
  focus: (ids) => set({ focusIds: ids, sel: ids, fitTick: get().fitTick }),
  removeSelected: () => {
    const { sel, mode } = get()
    if (!sel.length) return
    get().commit((p) => setObjs(p, mode, (l) => l.filter((o) => !sel.includes(o.id) || o.locked)))
  },
  duplicateSelected: () => {
    const { sel, mode } = get()
    if (!sel.length) return
    let ids: string[] = []
    get().commit((p) =>
      setObjs(p, mode, (l) => {
        const r = duplicate(l, sel)
        ids = r.ids
        return r.list
      }),
    )
    set({ sel: ids })
  },
  nudge: (dx, dy) => {
    const { sel, mode } = get()
    if (!sel.length) return
    get().commit((p) => setObjs(p, mode, (l) => l.map((o) => (sel.includes(o.id) && !o.locked ? moveObj(o, dx, dy) : o))))
  },
  toggleLayer: (id, key) => {
    const l = get().layers
    set({ layers: { ...l, [id]: { ...l[id], [key]: !l[id][key] } } })
  },
}))

export const selPlan = (s: State) => activePlan(s.project)

export function selectedObjs(s: State): Obj[] {
  const list = listObjs(s.project, s.mode)
  return list.filter((o) => s.sel.includes(o.id))
}

export { ensurePlan }

// ── 自動保存（このブラウザ内だけ。共有や永続保存にはプロジェクトファイルの書き出しを使う）
const KEY = 'current-v1'
let timer: ReturnType<typeof setTimeout> | null = null

export async function restore() {
  const saved = await idbGet<{ project: Project; themeId?: string }>(KEY)
  if (saved?.project?.v === 1 && saved.project.venue?.outline?.length >= 3) {
    useStore.setState({ project: saved.project, themeId: saved.themeId || 'light', past: [], future: [], sel: [] })
  }
  useStore.setState({ loaded: true })
  useStore.subscribe((s, prev) => {
    if (s.project === prev.project && s.themeId === prev.themeId) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const st = useStore.getState()
      void idbSet(KEY, { project: st.project, themeId: st.themeId })
    }, 900)
  })
}
