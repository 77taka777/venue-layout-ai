// ファイルの読み込み（画像・写真・PDF）、台形補正、保存、ブラウザ内への自動保存
import type { Pt } from '../core/types'

export interface LoadedImage {
  dataUrl: string
  w: number
  h: number
  kind: 'image' | 'pdf' | 'photo'
  name: string
  pages?: number
  texts?: { s: string; x: number; y: number }[]
}

const MAX_SIDE = 2400

export function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('画像を読み込めませんでした'))
    img.src = url
  })
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('ファイルを読み込めませんでした'))
    r.readAsDataURL(file)
  })
}

function flatten(img: CanvasImageSource, w: number, h: number, sw: number, sh: number): { dataUrl: string; w: number; h: number } {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, sw, sh, 0, 0, w, h)
  return { dataUrl: c.toDataURL('image/jpeg', 0.92), w, h }
}

export async function readImageFile(file: File): Promise<LoadedImage> {
  const url = await fileToDataUrl(file)
  const img = await loadImageEl(url)
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const out = flatten(img, Math.round(img.naturalWidth * k), Math.round(img.naturalHeight * k), img.naturalWidth, img.naturalHeight)
  return { ...out, kind: 'image', name: file.name }
}

export async function readPdfFile(file: File, pageNo = 1): Promise<LoadedImage> {
  const pdfjs = await import('pdfjs-dist')
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = worker
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const page = await doc.getPage(Math.max(1, Math.min(doc.numPages, pageNo)))
  const v1 = page.getViewport({ scale: 1 })
  const scale = Math.min(4, MAX_SIDE / Math.max(v1.width, v1.height))
  const vp = page.getViewport({ scale })
  const c = document.createElement('canvas')
  c.width = Math.round(vp.width)
  c.height = Math.round(vp.height)
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise
  // 図面内の文字（寸法・室名）を位置つきで抜き出し、AI解析の手がかりにする
  const texts: { s: string; x: number; y: number }[] = []
  try {
    const tc = await page.getTextContent()
    for (const it of tc.items as any[]) {
      const s = typeof it.str === 'string' ? it.str.trim() : ''
      if (!s || !it.transform) continue
      const t = pdfjs.Util.transform(vp.transform, it.transform)
      texts.push({ s: s.slice(0, 40), x: Math.round((t[4] / vp.width) * 1000), y: Math.round((t[5] / vp.height) * 1000) })
      if (texts.length >= 220) break
    }
  } catch {
    // 文字が取れなくても画像としては使える
  }
  return { dataUrl: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height, kind: 'pdf', name: file.name, pages: doc.numPages, texts }
}

export async function rotate90(dataUrl: string): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImageEl(dataUrl)
  const c = document.createElement('canvas')
  c.width = img.naturalHeight
  c.height = img.naturalWidth
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.translate(c.width, 0)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(img, 0, 0)
  return { dataUrl: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height }
}

/** src→dst の射影変換（8元連立を消去法で解く） */
function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    const d = A[c][c] || 1e-12
    for (let k = c; k < 9; k++) A[c][k] /= d
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r][c]
      if (!f) continue
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]
    }
  }
  return A.map((r) => r[8])
}

/** 写真の台形補正。quad は画像上の4点（左上→右上→右下→左下, px） */
export async function warpPerspective(dataUrl: string, quad: Pt[]): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImageEl(dataUrl)
  const sw = img.naturalWidth
  const sh = img.naturalHeight
  const sc = document.createElement('canvas')
  sc.width = sw
  sc.height = sh
  const sctx = sc.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
  sctx.drawImage(img, 0, 0)
  const sd = sctx.getImageData(0, 0, sw, sh).data
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  let W = Math.round(Math.max(d(quad[0], quad[1]), d(quad[3], quad[2])))
  let H = Math.round(Math.max(d(quad[0], quad[3]), d(quad[1], quad[2])))
  const k = Math.min(1, MAX_SIDE / Math.max(W, H))
  W = Math.max(8, Math.round(W * k))
  H = Math.max(8, Math.round(H * k))
  const h = homography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], quad)
  const oc = document.createElement('canvas')
  oc.width = W
  oc.height = H
  const octx = oc.getContext('2d') as CanvasRenderingContext2D
  const out = octx.createImageData(W, H)
  const od = out.data
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const den = h[6] * u + h[7] * v + 1
      const x = (h[0] * u + h[1] * v + h[2]) / den
      const y = (h[3] * u + h[4] * v + h[5]) / den
      const o = (v * W + u) * 4
      if (x < 0 || y < 0 || x > sw - 1 || y > sh - 1) {
        od[o] = od[o + 1] = od[o + 2] = 255
        od[o + 3] = 255
        continue
      }
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const x1 = Math.min(sw - 1, x0 + 1)
      const y1 = Math.min(sh - 1, y0 + 1)
      const fx = x - x0
      const fy = y - y0
      const i00 = (y0 * sw + x0) * 4
      const i10 = (y0 * sw + x1) * 4
      const i01 = (y1 * sw + x0) * 4
      const i11 = (y1 * sw + x1) * 4
      for (let c = 0; c < 3; c++) {
        od[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy
      }
      od[o + 3] = 255
    }
  }
  octx.putImageData(out, 0, 0)
  return { dataUrl: oc.toDataURL('image/jpeg', 0.92), w: W, h: H }
}

function canvasBlob(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を書き出せませんでした'))), type, q))
}

/** AIに渡す画像。座標を答えやすいよう、0–1000 の目盛りグリッドを重ねた版も作る */
export async function aiImages(dataUrl: string, maxSide = 1568): Promise<{ plain: Blob; grid: Blob }> {
  const img = await loadImageEl(dataUrl)
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * k)
  const h = Math.round(img.naturalHeight * k)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.drawImage(img, 0, 0, w, h)
  const plain = await canvasBlob(c)
  ctx.lineWidth = 1
  const fs = Math.max(11, Math.round(Math.min(w, h) / 62))
  ctx.font = `600 ${fs}px sans-serif`
  ctx.textBaseline = 'top'
  for (let i = 0; i <= 10; i++) {
    const x = Math.round((w * i) / 10)
    const y = Math.round((h * i) / 10)
    ctx.strokeStyle = i % 5 === 0 ? 'rgba(220,30,60,0.75)' : 'rgba(220,30,60,0.4)'
    ctx.beginPath()
    ctx.moveTo(Math.min(w - 0.5, x + 0.5), 0)
    ctx.lineTo(Math.min(w - 0.5, x + 0.5), h)
    ctx.moveTo(0, Math.min(h - 0.5, y + 0.5))
    ctx.lineTo(w, Math.min(h - 0.5, y + 0.5))
    ctx.stroke()
    const label = String(i * 100)
    const tw = ctx.measureText(label).width + 6
    const lx = Math.min(w - tw, Math.max(0, x + 2))
    ctx.fillStyle = 'rgba(255,255,255,0.88)'
    ctx.fillRect(lx, 0, tw, fs + 4)
    ctx.fillStyle = '#c0102c'
    ctx.fillText(label, lx + 3, 2)
    if (i > 0) {
      const ly = Math.min(h - fs - 4, Math.max(0, y + 2))
      ctx.fillStyle = 'rgba(255,255,255,0.88)'
      ctx.fillRect(0, ly, tw, fs + 4)
      ctx.fillStyle = '#c0102c'
      ctx.fillText(label, 3, ly + 2)
    }
  }
  const grid = await canvasBlob(c)
  return { plain, grid }
}

// ───────────────────────── 保存 ─────────────────────────

type ClaudeRuntime = { use: (name: string) => Promise<any> }
const runtime = (): ClaudeRuntime | null => (typeof window !== 'undefined' && (window as any).claude?.use ? ((window as any).claude as ClaudeRuntime) : null)

export async function capability<T = any>(name: string): Promise<T | null> {
  const rt = runtime()
  if (!rt) return null
  try {
    return ((await rt.use(name)) as T) || null
  } catch {
    return null
  }
}

export type SaveResult = 'saved' | 'declined' | 'failed'

/** 生成したファイルを保存する。Claudeの中では確認ダイアログ経由、単体で開いているときは通常のダウンロード */
export async function saveFile(filename: string, data: Blob | string): Promise<SaveResult> {
  const dl = await capability<{ save: (r: { filename: string; data: Blob | string }) => Promise<{ status: string }> }>('downloads')
  if (dl) {
    try {
      await dl.save({ filename, data })
      return 'saved'
    } catch (e: any) {
      if (e?.code === 'declined') return 'declined'
      if (e?.code !== 'unavailable' && e?.code !== 'not_granted' && e?.code !== 'capability_disabled') return 'failed'
    }
  }
  try {
    const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain;charset=utf-8' }) : data
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    // Claudeの枠の中ではブラウザ直接のダウンロードは無視される
    return runtime() ? 'failed' : 'saved'
  } catch {
    return 'failed'
  }
}

// ───────────────────────── 自動保存（IndexedDB） ─────────────────────────

const DB = 'event-floorplan-ai'
const STORE = 'kv'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    // 保存できなくても動作は続ける
  }
}
