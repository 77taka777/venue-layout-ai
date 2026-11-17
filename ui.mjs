// ヘッドレスChromeでの動作確認。usage: node scripts/ui.mjs <scenario>
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
const url = process.env.URL || 'http://127.0.0.1:4173/'
const scenario = process.argv[2] || 'shots'
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] })
const logs = []
async function open(w, h, mobile = false, init) {
  const page = await browser.newPage()
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile })
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 400)}`))
  if (init) await page.evaluateOnNewDocument(init)
  await page.goto(url, { waitUntil: 'networkidle0' })
  await new Promise((r) => setTimeout(r, 900))
  return page
}
const clickText = async (page, sel, text) => {
  const ok = await page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text))
    if (!el) return false
    el.click()
    return true
  }, sel, text)
  if (!ok) logs.push(`[test] not found: ${sel} "${text}"`)
  await new Promise((r) => setTimeout(r, 450))
}
if (scenario === 'shots') {
  const p = await open(1440, 860)
  await p.screenshot({ path: 'out/ui-desktop.png' })
  await clickText(p, '.tabs button', 'チェック')
  await p.screenshot({ path: 'out/ui-check.png' })
  await clickText(p, '.tabs button', '出力')
  await new Promise((r) => setTimeout(r, 600))
  await p.screenshot({ path: 'out/ui-export.png' })
  const m = await open(390, 780, true)
  await m.screenshot({ path: 'out/ui-mobile.png' })
}
if (scenario === 'edit') {
  const p = await open(1440, 860)
  // ステージをクリックして選択 → 詳細
  const box = await p.evaluate(() => { const c = document.querySelector('.canvas-wrap').getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height } })
  await p.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.2)
  await new Promise((r) => setTimeout(r, 300))
  await p.screenshot({ path: 'out/ui-select.png' })
  // ドラッグ
  await p.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.2)
  await p.mouse.down()
  await p.mouse.move(box.x + box.w * 0.56, box.y + box.h * 0.26, { steps: 8 })
  await p.mouse.up()
  await new Promise((r) => setTimeout(r, 300))
  await clickText(p, '.tabs button', '編集')
  await p.screenshot({ path: 'out/ui-drag.png' })
  await clickText(p, '.seg button', '会場')
  await clickText(p, '.tabs button', '図面')
  await p.screenshot({ path: 'out/ui-structure.png' })
}

const MOCK = () => {
  const analysis = { venue_name: 'テストホール', outline: [[52, 69], [948, 69], [948, 533], [600, 533], [600, 931], [52, 931]], columns: [], openings: [{ kind: 'entrance', x1: 271, y1: 931, x2: 331, y2: 931, label: '' }, { kind: 'emergency', x1: 948, y1: 280, x2: 948, y2: 320, label: '非常口' }], fixed: [], scale: { x1: 52, y1: 69, x2: 948, y2: 69, length_mm: 36000, evidence: '36,000' }, estimated_width_m: 36, notes: ['右奥の扉の種類は要確認'], confidence: { outline: 0.9, columns: 0.5, openings: 0.7, scale: 0.8 } }
  const plans = { plans: [{ name: 'AI案その1', concept: 'テスト方針', rationale: ['理由A', '理由B'], stageSide: 'opposite', stage: { on: true, scale: 1 }, seating: { style: 'classroom', count: 120, centerAisle: true }, vip: 0, side: { use: 'lounge', ratio: 0.2, at: 'far' }, booths: { count: 3, mode: 'wall' }, reception: 2, extras: [{ type: 'cloak', count: 1, near: 'entrance' }] }, { name: 'AI案その2', concept: '円卓', seating: { style: 'round', count: 100 } }, { name: 'AI案その3', concept: '立食', seating: { style: 'standing', count: 300 } }] }
  window.__calls = []
  window.__saved = []
  const sample = async () => ({ text: '{}', truncated: false })
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 2e7, mediaTypes: ['image/jpeg', 'image/png'] } })
  sample.json = async (input, opts) => {
    window.__calls.push({ len: input.length, images: opts?.images ? (opts.images.length || 1) : 0, tier: opts?.modelTier })
    await new Promise((r) => setTimeout(r, 150))
    if (input.includes('解析器')) return analysis
    if (input.includes('プランナー')) return plans
    const st = JSON.parse(input.split('現在の図面')[1].split('\n')[1])
    const stage = st.objects.find((o) => o.type === 'stage')
    return { ops: [{ op: 'update', id: stage.id, scale: 1.2 }, { op: 'add', type: 'cloak', cx: 5, cy: 5 }, { op: 'replan', brief: { booths: 4 } }], reply: 'ステージを20%拡大し、クロークを追加、ブースを4にしました。' }
  }
  const downloads = { save: async ({ filename, data }) => { window.__saved.push({ filename, size: data.size ?? data.length }); return { status: 'saved' } } }
  window.claude = { use: async (n) => (n === 'sample' ? sample : n === 'downloads' ? downloads : null) }
}
if (scenario === 'flow') {
  const p = await open(1440, 860, false, MOCK)
  await clickText(p, '.tabs button', '図面')
  const input = await p.$('#file-source')
  await input.uploadFile('out/fixture-lshape.png')
  await new Promise((r) => setTimeout(r, 1500))
  await p.screenshot({ path: 'out/f1-upload.png' })
  await clickText(p, 'button', 'AIで図面を読み取る')
  await new Promise((r) => setTimeout(r, 2500))
  await p.screenshot({ path: 'out/f2-analyzed.png' })
  await clickText(p, '.tabs button', '条件')
  await clickText(p, 'button', 'この条件で配置案を作る')
  await new Promise((r) => setTimeout(r, 900))
  await p.screenshot({ path: 'out/f3-plans.png' })
  await clickText(p, 'button', 'AIに方針を考えてもらう')
  await new Promise((r) => setTimeout(r, 1500))
  await p.screenshot({ path: 'out/f4-aiplans.png' })
  await clickText(p, '.tabs button', '編集')
  await p.type('#chat-cmd', 'ステージを20%大きく')
  await clickText(p, 'button', 'AIに指示する')
  await new Promise((r) => setTimeout(r, 1500))
  await p.screenshot({ path: 'out/f5-chat.png' })
  await clickText(p, '.tabs button', '出力')
  await clickText(p, 'button', 'PowerPoint（.pptx）')
  await new Promise((r) => setTimeout(r, 3500))
  await clickText(p, 'button', 'PDF')
  await new Promise((r) => setTimeout(r, 3500))
  await clickText(p, 'button', 'PNG（表示中の種類）')
  await new Promise((r) => setTimeout(r, 1500))
  await clickText(p, 'button', 'SVG（表示中の種類）')
  await new Promise((r) => setTimeout(r, 800))
  await clickText(p, 'button', 'プロジェクトを保存（.json）')
  await new Promise((r) => setTimeout(r, 800))
  const info = await p.evaluate(() => ({ calls: window.__calls, saved: window.__saved, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }))
  console.log(JSON.stringify(info, null, 1))
  await p.screenshot({ path: 'out/f6-export.png' })
  // PDF 読み込み
  await clickText(p, '.tabs button', '図面')
  const input2 = await p.$('#file-source')
  await input2.uploadFile('out/pp/sample.pdf')
  await new Promise((r) => setTimeout(r, 4000))
  await p.screenshot({ path: 'out/f7-pdf.png' })
  console.log('pdf pages select:', await p.evaluate(() => document.querySelector('#pdf-page')?.options.length || 0))
}

if (scenario === 'more') {
  const p = await open(1440, 860, false, MOCK)
  const state = () => p.evaluate(() => { const c = document.querySelector('.canvas-wrap').getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height } })
  const box = await state()
  // 会場モード：右下の頂点をドラッグ
  await clickText(p, '.top-actions .seg button', '会場')
  const before = await p.evaluate(() => document.querySelector('#v-w')?.value)
  await clickText(p, '.tabs button', '図面')
  const vw0 = await p.evaluate(() => document.querySelector('#v-w').value)
  // 頂点位置はスクリーンショットから：会場右下 ≈ (1360,759)
  await p.mouse.move(1360, 759); await p.mouse.down(); await p.mouse.move(1300, 700, { steps: 6 }); await p.mouse.up()
  await new Promise((r) => setTimeout(r, 400))
  const vw1 = await p.evaluate(() => [document.querySelector('#v-w').value, document.querySelector('#v-h').value])
  console.log('vertex drag: width', vw0, '->', vw1.join(' x '))
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control')
  await new Promise((r) => setTimeout(r, 300))
  console.log('after undo:', await p.evaluate(() => [document.querySelector('#v-w').value, document.querySelector('#v-h').value].join(' x ')))
  // 縮尺合わせ
  await clickText(p, 'button', '2点の実寸から縮尺を合わせる')
  await p.screenshot({ path: 'out/m1-calib.png' })
  await p.click('#cal-len', { clickCount: 3 }); await p.type('#cal-len', '60'); await p.keyboard.press('Enter')
  await clickText(p, 'button', 'この長さに合わせる')
  console.log('after calib(60m):', await p.evaluate(() => [document.querySelector('#v-w').value, document.querySelector('#v-h').value].join(' x ')))
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control')
  // 構造を追加
  await clickText(p, '.chips button', '＋柱')
  await clickText(p, '.chips button', '＋非常口')
  await p.screenshot({ path: 'out/m2-struct.png' })
  // 画像を読み込み → 台形補正 → 90°回転
  const input = await p.$('#file-source'); await input.uploadFile('out/fixture-lshape.png')
  await new Promise((r) => setTimeout(r, 1200))
  await clickText(p, 'button', '台形補正')
  await p.screenshot({ path: 'out/m3-warp.png' })
  await clickText(p, 'button', 'この範囲で補正する')
  await new Promise((r) => setTimeout(r, 2500))
  console.log('after warp:', await p.evaluate(() => document.querySelector('.src-meta span')?.textContent))
  await clickText(p, 'button', '90°回転')
  await new Promise((r) => setTimeout(r, 1500))
  await p.screenshot({ path: 'out/m4-rot.png' })
  // サンプルに戻して、客席ブロックをリサイズ
  await clickText(p, 'button', 'サンプルに戻す')
  await new Promise((r) => setTimeout(r, 600))
  await p.mouse.click(620, 460)
  await new Promise((r) => setTimeout(r, 300))
  const name0 = await p.evaluate(() => document.querySelector('.selbar')?.textContent)
  // 右下ハンドルをドラッグ（ブロック右下 ≈ (693,583)）
  await p.mouse.move(693, 583); await p.mouse.down(); await p.mouse.move(650, 540, { steps: 6 }); await p.mouse.up()
  await new Promise((r) => setTimeout(r, 400))
  console.log('seat block:', name0, '->', await p.evaluate(() => document.querySelector('.selbar')?.textContent))
  await p.screenshot({ path: 'out/m5-resize.png' })
  // キーボード操作
  await p.keyboard.press('ArrowRight'); await p.keyboard.down('Control'); await p.keyboard.press('d'); await p.keyboard.up('Control'); await p.keyboard.press('Delete')
  await clickText(p, '.tabs button', 'チェック')
  await p.screenshot({ path: 'out/m6-check.png' })
  // テーマ切り替え
  await p.select('#top-theme', 'noir')
  await new Promise((r) => setTimeout(r, 500))
  await p.screenshot({ path: 'out/m7-noir.png' })
  const m = await open(390, 780, true, MOCK)
  await m.touchscreen.tap(195, 300)
  await new Promise((r) => setTimeout(r, 400))
  await m.screenshot({ path: 'out/m8-mobile-sel.png' })
}
console.log(logs.length ? logs.join('\n') : 'no console errors')
await browser.close()
