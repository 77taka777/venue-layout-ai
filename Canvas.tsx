import Konva from 'konva'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Circle, Group, Image as KImage, Layer, Line, Rect, Shape, Stage, Text, Transformer } from 'react-konva'
import { CATALOG, layerOf, objName } from '../core/catalog'
import { clamp, norm360, objAABB, ptsBBox, snap as snapTo } from '../core/geometry'
import { glyph, venuePrims } from '../core/glyphs'
import type { GlyphEnv } from '../core/glyphs'
import { activePlan, fitSeatBlock, listObjs, moveObj, setFlowPts, setObjs, settle } from '../core/ops'
import { drawPrims } from '../core/prims'
import { seatBlockers } from '../core/seats'
import { setOutline } from '../core/structure'
import { getTheme } from '../core/themes'
import type { Obj, Pt } from '../core/types'
import { loadImageEl } from '../io/files'
import { makeEnv, sceneBBox } from '../render/scene'
import { useStore } from '../store'

Konva.hitOnDragEnabled = true

/** パレットから追加するときの「いま見えている中心」 */
export const viewport = { cx: 15000, cy: 10000, scale: 0.02 }

const ACCENT = '#1D5FD1'

interface NodeProps {
  o: Obj
  env: GlyphEnv
  interactive: boolean
  alpha: number
  hitW: number
  register: (id: string, n: Konva.Group | null) => void
  down: (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void
  dragStart: (e: Konva.KonvaEventObject<DragEvent>) => void
  dragMove: (e: Konva.KonvaEventObject<DragEvent>) => void
  dragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void
}

const ObjNode = memo(function ObjNode({ o, env, interactive, alpha, hitW, register, down, dragStart, dragMove, dragEnd }: NodeProps) {
  const prims = glyph(o, env)
  const isFlow = o.type === 'flow'
  return (
    <Group
      ref={(n) => register(o.id, n)}
      id={o.id}
      x={o.x + o.w / 2}
      y={o.y + o.h / 2}
      offsetX={o.w / 2}
      offsetY={o.h / 2}
      rotation={o.rot}
      listening={interactive}
      draggable={interactive && !o.locked}
      onMouseDown={down}
      onTouchStart={down}
      onDragStart={dragStart}
      onDragMove={dragMove}
      onDragEnd={dragEnd}
    >
      <Shape
        width={o.w}
        height={o.h}
        stroke="#000"
        strokeWidth={1}
        hitStrokeWidth={isFlow ? hitW : 0}
        perfectDrawEnabled={false}
        sceneFunc={(ctx) => drawPrims(ctx._context as CanvasRenderingContext2D, prims, o.rot, alpha)}
        hitFunc={(ctx, shape) => {
          ctx.beginPath()
          if (isFlow) {
            const pts: number[] = o.props?.pts || []
            for (let i = 0; i < pts.length; i += 2) {
              if (i === 0) ctx.moveTo(pts[i] - o.x, pts[i + 1] - o.y)
              else ctx.lineTo(pts[i] - o.x, pts[i + 1] - o.y)
            }
            ctx.strokeShape(shape)
          } else {
            const pad = Math.max(0, (hitW - Math.min(o.w, o.h)) / 2)
            ctx.rect(-pad, -pad, o.w + pad * 2, o.h + pad * 2)
            ctx.closePath()
            ctx.fillShape(shape)
          }
        }}
        fill="#000"
      />
    </Group>
  )
})

export function Canvas() {
  const wrap = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const nodes = useRef(new Map<string, Konva.Group>())
  const dragStartPos = useRef(new Map<string, Pt>())
  const pinch = useRef<{ d: number; c: Pt } | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [view, setView] = useState({ scale: 0.02, x: 0, y: 0 })
  const [draftOutline, setDraftOutline] = useState<Pt[] | null>(null)
  const [draftFlow, setDraftFlow] = useState<{ id: string; pts: number[] } | null>(null)
  const [srcImg, setSrcImg] = useState<HTMLImageElement | null>(null)

  const project = useStore((s) => s.project)
  const mode = useStore((s) => s.mode)
  const sel = useStore((s) => s.sel)
  const layers = useStore((s) => s.layers)
  const themeId = useStore((s) => s.themeId)
  const fitTick = useStore((s) => s.fitTick)
  const focusIds = useStore((s) => s.focusIds)
  const calib = useStore((s) => s.calib)

  const plan = activePlan(project)
  const theme = getTheme(themeId)
  const venue = useMemo(() => (draftOutline ? { ...project.venue, outline: draftOutline } : project.venue), [project.venue, draftOutline])
  const blockers = seatBlockers(project.structure, plan ? plan.objects : null)
  const env = useMemo(
    () => makeEnv({ ...project, venue }, theme, true, 1, plan),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [venue, project.structure, theme, blockers],
  )
  const vp = useMemo(() => venuePrims(venue, theme), [venue, theme])

  // ── サイズ追従
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) }))
    ro.observe(el)
    setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) })
    return () => ro.disconnect()
  }, [])

  const fitTo = useCallback(
    (bb: { x: number; y: number; w: number; h: number }, pad = 28) => {
      const s = clamp(Math.min((size.w - pad * 2) / Math.max(1, bb.w), (size.h - pad * 2) / Math.max(1, bb.h)), 0.0008, 0.6)
      setView({ scale: s, x: (size.w - bb.w * s) / 2 - bb.x * s, y: (size.h - bb.h * s) / 2 - bb.y * s })
    },
    [size.w, size.h],
  )
  const bbKey = useMemo(() => {
    const b = ptsBBox(project.venue.outline)
    return `${Math.round(b.w)}x${Math.round(b.h)}`
  }, [project.venue.outline])
  useEffect(() => {
    fitTo(sceneBBox(project))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTick, bbKey, size.w, size.h])

  useEffect(() => {
    viewport.scale = view.scale
    viewport.cx = (size.w / 2 - view.x) / view.scale
    viewport.cy = (size.h / 2 - view.y) / view.scale
  }, [view, size])

  // ── チェック結果からのフォーカス
  useEffect(() => {
    if (!focusIds.length) return
    const list = [...listObjs(project, 'layout'), ...project.structure].filter((o) => focusIds.includes(o.id))
    if (!list.length) return
    const bs = list.map((o) => objAABB(o))
    const x0 = Math.min(...bs.map((b) => b.x))
    const y0 = Math.min(...bs.map((b) => b.y))
    const x1 = Math.max(...bs.map((b) => b.x + b.w))
    const y1 = Math.max(...bs.map((b) => b.y + b.h))
    const pad = Math.max(3000, (x1 - x0) * 0.6, (y1 - y0) * 0.6)
    fitTo({ x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }, 10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIds])

  // ── 元図面
  const srcUrl = project.source?.dataUrl
  useEffect(() => {
    let live = true
    if (!srcUrl) {
      setSrcImg(null)
      return
    }
    loadImageEl(srcUrl).then((img) => live && setSrcImg(img)).catch(() => live && setSrcImg(null))
    return () => {
      live = false
    }
  }, [srcUrl])

  // ── オブジェクトの並び
  const objs = useMemo(() => {
    const list = plan ? plan.objects.filter((o) => !o.hidden && layers[layerOf(o)]?.visible) : []
    if (draftFlow) return list.map((o) => (o.id === draftFlow.id ? setFlowPts(o, draftFlow.pts) : o))
    return list
  }, [plan, layers, draftFlow])
  const struct = useMemo(() => (layers.structure.visible ? project.structure.filter((s) => !s.hidden) : []), [project.structure, layers.structure.visible])
  const zOf = (o: Obj) => CATALOG[o.type]?.z ?? 8
  const zones = objs.filter((o) => o.type === 'zone')
  const body = useMemo(() => objs.filter((o) => o.type !== 'zone' && o.type !== 'flow' && o.type !== 'label').sort((a, b) => zOf(a) - zOf(b)), [objs])
  const flows = objs.filter((o) => o.type === 'flow')
  const labels = objs.filter((o) => o.type === 'label')
  const structLow = struct.filter((s) => s.type === 'fixed' || s.type === 'nogo')
  const structHigh = struct.filter((s) => s.type !== 'fixed' && s.type !== 'nogo')

  // ── 選択・ドラッグ
  const register = useCallback((id: string, n: Konva.Group | null) => {
    if (n) nodes.current.set(id, n)
    else nodes.current.delete(id)
  }, [])

  const down = useCallback((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const id = e.currentTarget.id()
    const st = useStore.getState()
    const ev = e.evt as MouseEvent
    const additive = !!(ev.shiftKey || ev.metaKey || ev.ctrlKey)
    if (additive) st.select([id], true)
    else if (!st.sel.includes(id)) st.select([id])
  }, [])

  const dragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const st = useStore.getState()
    const id = e.currentTarget.id()
    if (!st.sel.includes(id)) st.select([id])
    dragStartPos.current.clear()
    for (const sid of useStore.getState().sel) {
      const n = nodes.current.get(sid)
      if (n) dragStartPos.current.set(sid, { x: n.x(), y: n.y() })
    }
  }, [])

  const dragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const st = useStore.getState()
    const n = e.currentTarget as Konva.Group
    const id = n.id()
    const start = dragStartPos.current.get(id)
    if (!start) return
    const o = listObjs(st.project, st.mode).find((x) => x.id === id)
    if (o && st.snap > 0 && o.type !== 'entrance' && o.type !== 'flow') {
      const r = norm360(o.rot)
      if (r % 90 === 0) {
        const ew = r % 180 === 0 ? o.w : o.h
        const eh = r % 180 === 0 ? o.h : o.w
        n.x(snapTo(n.x() - ew / 2, st.snap) + ew / 2)
        n.y(snapTo(n.y() - eh / 2, st.snap) + eh / 2)
      }
    }
    const dx = n.x() - start.x
    const dy = n.y() - start.y
    for (const [sid, p] of dragStartPos.current) {
      if (sid === id) continue
      const other = nodes.current.get(sid)
      if (other) other.position({ x: p.x + dx, y: p.y + dy })
    }
  }, [])

  const dragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    const st = useStore.getState()
    const n = e.currentTarget as Konva.Group
    const start = dragStartPos.current.get(n.id())
    if (!start) return
    const dx = n.x() - start.x
    const dy = n.y() - start.y
    const ids = [...dragStartPos.current.keys()]
    dragStartPos.current.clear()
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      st.commit((p) => setObjs(p, st.mode, (l) => l.map((o) => (ids.includes(o.id) && !o.locked ? settle(moveObj(o, dx, dy), p, 0) : o))))
    }
    // Konva側の位置を確定後の値に合わせ直す（壁スナップなどで戻る場合があるため）
    const after = listObjs(useStore.getState().project, st.mode)
    for (const id of ids) {
      const o = after.find((x) => x.id === id)
      const node = nodes.current.get(id)
      if (o && node) node.position({ x: o.x + o.w / 2, y: o.y + o.h / 2 })
    }
  }, [])

  // ── Transformer
  useEffect(() => {
    const tr = trRef.current
    if (!tr) return
    const list = listObjs(project, mode)
    const targets = sel
      .map((id) => ({ o: list.find((x) => x.id === id), n: nodes.current.get(id) }))
      .filter((t) => t.o && t.n && t.o.type !== 'flow' && t.o.type !== 'entrance' && !t.o.locked)
      .map((t) => t.n as Konva.Group)
    tr.nodes(targets)
    tr.getLayer()?.batchDraw()
  }, [sel, project, mode, objs, struct])

  const onTransformEnd = useCallback(() => {
    const tr = trRef.current
    if (!tr) return
    const st = useStore.getState()
    const patch = new Map<string, { w: number; h: number; rot: number; cx: number; cy: number }>()
    for (const node of tr.nodes()) {
      const o = listObjs(st.project, st.mode).find((x) => x.id === node.id())
      if (!o) continue
      patch.set(o.id, { w: Math.max(50, o.w * Math.abs(node.scaleX())), h: Math.max(50, o.h * Math.abs(node.scaleY())), rot: norm360(Math.round(node.rotation())), cx: node.x(), cy: node.y() })
      node.scaleX(1)
      node.scaleY(1)
    }
    st.commit((p) =>
      setObjs(p, st.mode, (l) =>
        l.map((o) => {
          const t = patch.get(o.id)
          if (!t) return o
          const g = st.snap > 0 ? st.snap : 1
          let n: Obj = fitSeatBlock({ ...o, rot: t.rot }, snapTo(t.w, g) || g, snapTo(t.h, g) || g)
          if (o.type === 'round_table' || (o.type === 'column' && o.props?.round)) {
            const d = Math.max(n.w, n.h)
            n = { ...n, w: d, h: d }
          }
          return { ...n, x: t.cx - n.w / 2, y: t.cy - n.h / 2 }
        }),
      ),
    )
    const after = listObjs(useStore.getState().project, st.mode)
    for (const node of tr.nodes()) {
      const o = after.find((x) => x.id === node.id())
      if (o) {
        node.position({ x: o.x + o.w / 2, y: o.y + o.h / 2 })
        node.rotation(o.rot)
      }
    }
    tr.getLayer()?.batchDraw()
  }, [])

  // ── ステージ操作（パン・ズーム）
  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const s = clamp(v.scale * factor, 0.0008, 0.8)
      return { scale: s, x: px - ((px - v.x) / v.scale) * s, y: py - ((py - v.y) / v.scale) * s }
    })
  }, [])
  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const p = stageRef.current?.getPointerPosition()
    if (!p) return
    zoomAt(p.x, p.y, e.evt.deltaY < 0 ? 1.12 : 1 / 1.12)
  }
  const onTouchMove = (e: Konva.KonvaEventObject<TouchEvent>) => {
    const t = e.evt.touches
    if (t.length !== 2) return
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    if (stage.isDragging()) stage.stopDrag()
    const rect = stage.container().getBoundingClientRect()
    const a = { x: t[0].clientX - rect.left, y: t[0].clientY - rect.top }
    const b = { x: t[1].clientX - rect.left, y: t[1].clientY - rect.top }
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    const prev = pinch.current
    pinch.current = { d, c }
    if (!prev || !prev.d) return
    setView((v) => {
      const s = clamp(v.scale * (d / prev.d), 0.0008, 0.8)
      const wx = (prev.c.x - v.x) / v.scale
      const wy = (prev.c.y - v.y) / v.scale
      return { scale: s, x: c.x - wx * s, y: c.y - wy * s }
    })
  }
  const onTouchEnd = () => {
    pinch.current = null
  }
  const onStageDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (e.target === e.target.getStage()) useStore.getState().select([])
  }
  const onStageDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    const stage = e.target.getStage()
    if (stage && e.target === stage) setView((v) => ({ ...v, x: stage.x(), y: stage.y() }))
  }

  const px = 1 / view.scale // 画面1pxぶんのmm
  const hitW = 16 * px
  const layoutMode = mode === 'layout'
  const canEdit = (o: Obj) => layoutMode && !layers[layerOf(o)]?.locked
  const handlers = { register, down, dragStart, dragMove, dragEnd }

  // ── 輪郭の頂点ハンドル（会場編集モード）
  const outline = venue.outline
  const moveVertex = (i: number, x: number, y: number): Pt[] => {
    const st = useStore.getState()
    const g = st.snap || 50
    let nx = snapTo(x, g)
    let ny = snapTo(y, g)
    const n = outline.length
    for (const j of [(i - 1 + n) % n, (i + 1) % n]) {
      if (Math.abs(outline[j].x - nx) < 10 * px) nx = outline[j].x
      if (Math.abs(outline[j].y - ny) < 10 * px) ny = outline[j].y
    }
    return outline.map((p, k) => (k === i ? { x: nx, y: ny } : p))
  }

  // ── 動線の頂点ハンドル
  const selFlow = layoutMode && sel.length === 1 ? flows.find((f) => f.id === sel[0]) : undefined
  const flowPts: number[] = selFlow?.props?.pts || []

  // ── グリッド
  const gridStep = view.scale > 0.012 ? 1000 : view.scale > 0.004 ? 5000 : 10000
  const bb = ptsBBox(outline)

  const measured = calib ? Math.hypot(calib.b.x - calib.a.x, calib.b.y - calib.a.y) : 0

  return (
    <div ref={wrap} className="canvas-wrap" style={{ background: theme.dark ? theme.paper : undefined }}>
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        scaleX={view.scale}
        scaleY={view.scale}
        x={view.x}
        y={view.y}
        draggable
        onWheel={onWheel}
        onMouseDown={onStageDown}
        onTouchStart={onStageDown}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onDragEnd={onStageDragEnd}
      >
        <Layer listening={false}>
          <Shape sceneFunc={(ctx) => drawPrims(ctx._context as CanvasRenderingContext2D, vp.floor)} />
          {srcImg && project.source && layers.source.visible && (
            <KImage image={srcImg} x={project.source.x} y={project.source.y} width={project.source.wPx * project.source.mmPerPx} height={project.source.hPx * project.source.mmPerPx} opacity={mode === 'structure' ? Math.max(0.6, project.source.opacity) : project.source.opacity} />
          )}
          <Shape
            sceneFunc={(ctx) => {
              const c = ctx._context as CanvasRenderingContext2D
              c.strokeStyle = theme.grid
              c.lineWidth = px
              c.globalAlpha = srcImg && layers.source.visible ? 0.35 : 0.9
              c.beginPath()
              for (let x = Math.ceil(bb.x / gridStep) * gridStep; x <= bb.x + bb.w; x += gridStep) {
                c.moveTo(x, bb.y)
                c.lineTo(x, bb.y + bb.h)
              }
              for (let y = Math.ceil(bb.y / gridStep) * gridStep; y <= bb.y + bb.h; y += gridStep) {
                c.moveTo(bb.x, y)
                c.lineTo(bb.x + bb.w, y)
              }
              c.stroke()
              c.globalAlpha = 1
            }}
          />
        </Layer>
        <Layer>
          {zones.map((o) => <ObjNode key={o.id} o={o} env={env} interactive={canEdit(o)} alpha={layoutMode ? 1 : 0.3} hitW={0} {...handlers} />)}
          {structLow.map((o) => <ObjNode key={o.id} o={o} env={env} interactive={!layoutMode} alpha={1} hitW={hitW} {...handlers} />)}
          {body.map((o) => <ObjNode key={o.id} o={o} env={env} interactive={canEdit(o)} alpha={layoutMode ? 1 : 0.3} hitW={hitW} {...handlers} />)}
          <Shape listening={false} sceneFunc={(ctx) => drawPrims(ctx._context as CanvasRenderingContext2D, vp.walls)} />
          {structHigh.map((o) => <ObjNode key={o.id} o={o} env={env} interactive={!layoutMode} alpha={1} hitW={hitW} {...handlers} />)}
          {flows.map((o) => <ObjNode key={o.id} o={o} env={env} interactive={canEdit(o)} alpha={layoutMode ? 1 : 0.3} hitW={hitW} {...handlers} />)}
          {labels.map((o) => <ObjNode key={o.id} o={o} env={env} interactive={canEdit(o)} alpha={layoutMode ? 1 : 0.3} hitW={hitW} {...handlers} />)}
        </Layer>
        <Layer>
          <Transformer
            ref={trRef}
            rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
            rotationSnapTolerance={7}
            keepRatio={false}
            ignoreStroke
            anchorSize={11}
            anchorCornerRadius={2}
            anchorStroke={ACCENT}
            anchorFill="#fff"
            borderStroke={ACCENT}
            borderStrokeWidth={1.5}
            rotateAnchorOffset={26}
            boundBoxFunc={(oldB, newB) => (Math.abs(newB.width) < 8 || Math.abs(newB.height) < 4 ? oldB : newB)}
            onTransformEnd={onTransformEnd}
          />
          {/* 選択中の動線・出入口の強調 */}
          {sel.map((id) => {
            const o = [...flows, ...struct].find((x) => x.id === id)
            if (!o) return null
            if (o.type === 'flow') return <Line key={id} points={(o.props?.pts as number[]) || []} stroke={ACCENT} strokeWidth={3 * px} opacity={0.35} listening={false} lineCap="round" lineJoin="round" />
            if (o.type === 'entrance' && !layoutMode)
              return <Rect key={id} x={o.x + o.w / 2} y={o.y + o.h / 2} offsetX={o.w / 2 + 3 * px} offsetY={o.h / 2 + 3 * px} width={o.w + 6 * px} height={o.h + 6 * px} rotation={o.rot} stroke={ACCENT} strokeWidth={1.5 * px} dash={[5 * px, 4 * px]} listening={false} />
            return null
          })}
          {/* 動線の頂点 */}
          {selFlow &&
            Array.from({ length: flowPts.length / 2 }, (_, i) => (
              <Circle
                key={`fp${i}`}
                x={flowPts[i * 2]}
                y={flowPts[i * 2 + 1]}
                radius={7 * px}
                fill="#fff"
                stroke={ACCENT}
                strokeWidth={2 * px}
                draggable
                onDragMove={(e) => {
                  const g = useStore.getState().snap || 50
                  const pts = flowPts.slice()
                  pts[i * 2] = snapTo(e.target.x(), g)
                  pts[i * 2 + 1] = snapTo(e.target.y(), g)
                  setDraftFlow({ id: selFlow.id, pts })
                }}
                onDragEnd={(e) => {
                  const g = useStore.getState().snap || 50
                  const pts = flowPts.slice()
                  pts[i * 2] = snapTo(e.target.x(), g)
                  pts[i * 2 + 1] = snapTo(e.target.y(), g)
                  setDraftFlow(null)
                  useStore.getState().commit((p) => setObjs(p, 'layout', (l) => l.map((o) => (o.id === selFlow.id ? setFlowPts(o, pts) : o))))
                }}
                onDblClick={() => removeFlowPt(selFlow, i)}
                onDblTap={() => removeFlowPt(selFlow, i)}
              />
            ))}
          {selFlow &&
            Array.from({ length: flowPts.length / 2 - 1 }, (_, i) => (
              <Circle
                key={`fm${i}`}
                x={(flowPts[i * 2] + flowPts[i * 2 + 2]) / 2}
                y={(flowPts[i * 2 + 1] + flowPts[i * 2 + 3]) / 2}
                radius={5 * px}
                fill={ACCENT}
                opacity={0.55}
                onMouseDown={(e) => addFlowPt(selFlow, i, e)}
                onTouchStart={(e) => addFlowPt(selFlow, i, e)}
              />
            ))}
          {/* 会場の輪郭の頂点 */}
          {!layoutMode &&
            outline.map((p, i) => {
              const q = outline[(i + 1) % outline.length]
              return (
                <Circle
                  key={`om${i}`}
                  x={(p.x + q.x) / 2}
                  y={(p.y + q.y) / 2}
                  radius={5 * px}
                  fill={ACCENT}
                  opacity={0.5}
                  onMouseDown={(e) => insertVertex(i, e)}
                  onTouchStart={(e) => insertVertex(i, e)}
                />
              )
            })}
          {!layoutMode &&
            outline.map((p, i) => (
              <Rect
                key={`ov${i}`}
                x={p.x}
                y={p.y}
                offsetX={6 * px}
                offsetY={6 * px}
                width={12 * px}
                height={12 * px}
                fill="#fff"
                stroke={ACCENT}
                strokeWidth={2 * px}
                hitStrokeWidth={14 * px}
                draggable
                onDragMove={(e) => setDraftOutline(moveVertex(i, e.target.x(), e.target.y()))}
                onDragEnd={(e) => {
                  const next = moveVertex(i, e.target.x(), e.target.y())
                  setDraftOutline(null)
                  useStore.getState().commit((pr) => setOutline(pr, next))
                }}
                onDblClick={() => removeVertex(i)}
                onDblTap={() => removeVertex(i)}
              />
            ))}
          {/* 縮尺合わせの2点 */}
          {calib && (
            <>
              <Line points={[calib.a.x, calib.a.y, calib.b.x, calib.b.y]} stroke="#E0457B" strokeWidth={2 * px} dash={[8 * px, 5 * px]} listening={false} />
              {(['a', 'b'] as const).map((k) => (
                <Circle
                  key={k}
                  x={calib[k].x}
                  y={calib[k].y}
                  radius={9 * px}
                  fill="#fff"
                  stroke="#E0457B"
                  strokeWidth={3 * px}
                  draggable
                  onDragMove={(e) => useStore.getState().set({ calib: { ...calib, [k]: { x: e.target.x(), y: e.target.y() } } })}
                />
              ))}
              <Text x={(calib.a.x + calib.b.x) / 2 + 12 * px} y={(calib.a.y + calib.b.y) / 2 + 8 * px} text={`いまの図面上 ${(measured / 1000).toFixed(2)} m`} fontSize={13 * px} fill="#E0457B" fontStyle="600" listening={false} />
            </>
          )}
        </Layer>
      </Stage>
      <div className="hud">
        <button type="button" className="icon-btn" aria-label="拡大" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.3)}>＋</button>
        <button type="button" className="icon-btn" aria-label="縮小" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.3)}>−</button>
        <button type="button" className="icon-btn wide" onClick={() => fitTo(sceneBBox(project))}>全体</button>
      </div>
      <SelectionBar />
    </div>
  )

  function removeVertex(i: number) {
    if (outline.length <= 3) return
    const next = outline.filter((_, k) => k !== i)
    useStore.getState().commit((pr) => setOutline(pr, next))
  }
  function insertVertex(i: number, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    e.cancelBubble = true
    const p = outline[i]
    const q = outline[(i + 1) % outline.length]
    const next = [...outline.slice(0, i + 1), { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, ...outline.slice(i + 1)]
    // 一直線上の点は整形で消えるので、整形せずにそのまま入れる
    useStore.getState().commit((pr) => ({ ...pr, sample: false, venue: { ...pr.venue, outline: next } }))
  }
  function addFlowPt(f: Obj, i: number, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    e.cancelBubble = true
    const pts: number[] = (f.props?.pts as number[]).slice()
    pts.splice(i * 2 + 2, 0, (pts[i * 2] + pts[i * 2 + 2]) / 2, (pts[i * 2 + 1] + pts[i * 2 + 3]) / 2)
    useStore.getState().commit((p) => setObjs(p, 'layout', (l) => l.map((o) => (o.id === f.id ? setFlowPts(o, pts) : o))))
  }
  function removeFlowPt(f: Obj, i: number) {
    const pts: number[] = (f.props?.pts as number[]).slice()
    if (pts.length <= 4) return
    pts.splice(i * 2, 2)
    useStore.getState().commit((p) => setObjs(p, 'layout', (l) => l.map((o) => (o.id === f.id ? setFlowPts(o, pts) : o))))
  }
}

/** 選択中のオブジェクトに対するクイック操作 */
function SelectionBar() {
  const sel = useStore((s) => s.sel)
  const mode = useStore((s) => s.mode)
  const project = useStore((s) => s.project)
  if (!sel.length) return null
  const list = listObjs(project, mode).filter((o) => sel.includes(o.id))
  if (!list.length) return null
  const st = useStore.getState()
  const one = list.length === 1 ? list[0] : null
  const rotate = () =>
    st.commit((p) => setObjs(p, mode, (l) => l.map((o) => (sel.includes(o.id) && o.type !== 'flow' && o.type !== 'entrance' ? { ...o, rot: norm360(o.rot + 90) } : o))))
  const lock = () => st.commit((p) => setObjs(p, mode, (l) => l.map((o) => (sel.includes(o.id) ? { ...o, locked: !list.every((x) => x.locked) } : o))))
  return (
    <div className="selbar" role="toolbar" aria-label="選択中の操作">
      <span className="selbar-name">{one ? objName(one) : `${list.length}個を選択`}</span>
      {one && <span className="selbar-dim">{(one.w / 1000).toFixed(1)}×{(one.h / 1000).toFixed(1)}m</span>}
      <button type="button" onClick={rotate}>90°回転</button>
      <button type="button" onClick={() => st.duplicateSelected()}>複製</button>
      <button type="button" onClick={lock}>{list.every((x) => x.locked) ? '固定を解除' : '固定'}</button>
      <button type="button" className="danger" onClick={() => st.removeSelected()}>削除</button>
      <button type="button" onClick={() => st.setTab(mode === 'structure' ? 'source' : 'edit')}>詳細</button>
    </div>
  )
}
