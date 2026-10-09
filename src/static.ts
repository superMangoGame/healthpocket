import type { IncomingMessage, ServerResponse } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { STATIC_ASSETS } from 'virtual:healthpocket-assets'

export const APP_PREFIX = '/heathpocket/app'

/** Every served byte comes from the reviewed main.js bundle, including atlas data. */
export async function handleStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return }
  let path: string
  try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).slice(APP_PREFIX.length).replace(/^\/+/, '') }
  catch { res.writeHead(400); res.end(); return }
  if (path.includes('..') || path.includes('\\') || path.includes('\0')) { res.writeHead(404); res.end(); return }
  path = path.replace(/\/$/, '')
  const key = !path ? 'index.html' : [path, `${path}.html`, `${path}/index.html`].find((candidate) => Object.hasOwn(STATIC_ASSETS, candidate))
  const asset = key ? STATIC_ASSETS[key] : undefined
  if (!asset) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('页面不存在'); return }
  const compressed = Buffer.from(asset.body, 'base64')
  const acceptsGzip = /(?:^|[,\s])gzip(?:[,\s;]|$)/.test(req.headers['accept-encoding'] ?? '')
  const body = acceptsGzip ? compressed : gunzipSync(compressed)
  res.writeHead(200, { 'content-type': asset.contentType, 'content-length': body.length,
    'cache-control': key?.startsWith('_next/') || key?.endsWith('.bin.gz') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Accept-Encoding', ...(acceptsGzip ? { 'content-encoding': 'gzip' } : {}) })
  res.end(req.method === 'HEAD' ? undefined : body)
}
