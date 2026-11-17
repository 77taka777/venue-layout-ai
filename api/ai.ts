const MODEL = 'claude-sonnet-5-5'
const MAX_BODY_BYTES = 4_000_000
const MAX_PROMPT_CHARS = 24_000
const MAX_IMAGES = 2
const WINDOW_MS = 60_000
const REQUESTS_PER_WINDOW = 8

const buckets = new Map<string, { start: number; count: number }>()

function json(res: any, status: number, body: unknown) {
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  return res.status(status).json(body)
}

export const config = { maxDuration: 60 }

export default async function handler(req: any, res: any) {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (req.method === 'GET') {
    return json(res, 200, { available: Boolean(apiKey) })
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return json(res, 405, { error: 'method_not_allowed' })
  }

  const origin = req.headers.origin
  const host = req.headers['x-forwarded-host'] || req.headers.host
  try {
    if (!origin || !host || new URL(origin).host !== host) {
      return json(res, 403, { error: 'forbidden' })
    }
  } catch {
    return json(res, 403, { error: 'forbidden' })
  }

  if (!apiKey) return json(res, 503, { error: 'configuration_error' })

  const length = Number(req.headers['content-length'] || 0)
  if (length > MAX_BODY_BYTES) return json(res, 413, { error: 'prompt_too_large' })

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body) } catch { return null } })() : req.body
  const prompt = body?.prompt
  const images = body?.images ?? []
  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS || !Array.isArray(images) || images.length > MAX_IMAGES) {
    return json(res, 400, { error: 'invalid_request' })
  }

  let serializedBytes = 0
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  } catch {
    return json(res, 400, { error: 'invalid_request' })
  }
  if (serializedBytes > MAX_BODY_BYTES) return json(res, 413, { error: 'prompt_too_large' })

  for (const image of images) {
    if (!image || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mediaType) ||
      typeof image.data !== 'string' || image.data.length > 2_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
      return json(res, 400, { error: 'invalid_request' })
    }
  }

  const forwardedFor = req.headers['x-forwarded-for']
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor || 'unknown').split(',')[0].trim()
  const now = Date.now()
  const bucket = buckets.get(ip)
  if (bucket && now - bucket.start < WINDOW_MS && bucket.count >= REQUESTS_PER_WINDOW) {
    res.setHeader('Retry-After', String(Math.ceil((WINDOW_MS - (now - bucket.start)) / 1000)))
    return json(res, 429, { error: 'rate_limited' })
  }
  if (!bucket || now - bucket.start >= WINDOW_MS) buckets.set(ip, { start: now, count: 1 })
  else bucket.count += 1
  if (buckets.size > 2_000) {
    for (const [key, value] of buckets) if (now - value.start >= WINDOW_MS) buckets.delete(key)
  }

  const content: any[] = images.map((image: any) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.data },
  }))
  content.push({ type: 'text', text: prompt })

  let upstream: Response
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(55_000),
    })
  } catch {
    return json(res, 502, { error: 'upstream_unavailable' })
  }

  if (!upstream.ok) {
    if (upstream.status === 429 || upstream.status === 529) return json(res, 429, { error: 'rate_limited' })
    if (upstream.status === 413) return json(res, 413, { error: 'prompt_too_large' })
    return json(res, 502, { error: upstream.status === 401 || upstream.status === 403 ? 'configuration_error' : 'upstream_error' })
  }

  let result: any
  try {
    result = await upstream.json()
  } catch {
    return json(res, 502, { error: 'upstream_error' })
  }
  const text = Array.isArray(result?.content) ? result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') : ''
  if (!text) return json(res, 502, { error: 'empty_completion' })
  return json(res, 200, { text, truncated: result.stop_reason === 'max_tokens' })
}
