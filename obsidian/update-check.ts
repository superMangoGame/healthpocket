import { requestUrl } from 'obsidian'
import { createHash } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RELEASES_REPO = 'superMangoGame/healthpocket'
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`

/**
 * Where the published manifest.json is read from, in order. raw.githubusercontent.com
 * is often unreachable in mainland China, so jsDelivr's mirror of the same file is
 * the fallback (it caches for up to ~12 hours).
 */
const MANIFEST_SOURCES = [
  `https://raw.githubusercontent.com/${RELEASES_REPO}/main/manifest.json`,
  `https://cdn.jsdelivr.net/gh/${RELEASES_REPO}@main/manifest.json`,
]

export interface UpdateCheckResult {
  current: string
  latest: string
  hasUpdate: boolean
  releasesPage: string
}

/** Compares x.y.z versions; returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Only checks and reports; installing goes through the release page, never a self-update. */
export async function checkForUpdate(current: string): Promise<UpdateCheckResult> {
  const errors: string[] = []
  for (const url of MANIFEST_SOURCES) {
    try {
      // A cache-busting query keeps raw.githubusercontent.com from serving a stale copy.
      const response = await requestUrl({ url: `${url}?t=${Date.now()}`, throw: false })
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const latest = (response.json as { version?: unknown }).version
      if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('远端版本号无效')
      return { current, latest, hasUpdate: compareVersions(latest, current) > 0, releasesPage: RELEASES_PAGE }
    } catch (error) {
      errors.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`无法获取最新版本（${errors.join('；')}）`)
}

const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'] as const
/** main.js is ~50 MB, so it comes in ranged chunks to report progress and retry a dropped piece. */
const CHUNK_BYTES = 2 * 1024 * 1024
const ATTEMPTS = 3

export interface DownloadProgress {
  received: number
  total: number
}

async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await task() } catch (error) {
      if (attempt >= ATTEMPTS) throw error
      await new Promise((resolve) => window.setTimeout(resolve, 1000 * attempt))
    }
  }
}

/**
 * Downloads one release's plugin files into `pluginDir`, replacing the files of
 * the running build (the loaded code stays in memory until the plugin restarts).
 * Every file is checked against the release's SHA256SUMS.txt and staged next to
 * its target first, so a failed download leaves the installed version untouched.
 */
export async function downloadUpdate(version: string, pluginId: string, pluginDir: string, onProgress: (progress: DownloadProgress) => void): Promise<void> {
  const base = `https://github.com/${RELEASES_REPO}/releases/download/${version}`
  const fetchBytes = (name: string) => withRetry(async () => {
    const response = await requestUrl({ url: `${base}/${name}`, throw: false })
    if (response.status !== 200) throw new Error(`下载 ${name} 失败（HTTP ${response.status}）`)
    return new Uint8Array(response.arrayBuffer)
  })
  const fetchChunked = async (name: string) => {
    const chunks: Uint8Array[] = []
    let received = 0
    let total = Infinity
    while (received < total) {
      const end = received + CHUNK_BYTES - 1
      const response = await withRetry(async () => {
        const result = await requestUrl({ url: `${base}/${name}`, headers: { Range: `bytes=${received}-${end}` }, throw: false })
        if (result.status !== 206 && result.status !== 200) throw new Error(`下载 ${name} 失败（HTTP ${result.status}）`)
        return result
      })
      const bytes = new Uint8Array(response.arrayBuffer)
      if (response.status === 200) {
        // The server ignored the range and sent the whole file.
        onProgress({ received: bytes.length, total: bytes.length })
        return bytes
      }
      const range = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-range')?.[1]
      const size = Number(range?.split('/')[1])
      if (!Number.isFinite(size) || size <= 0) throw new Error(`下载 ${name} 失败：无法确定文件大小`)
      total = size
      chunks.push(bytes)
      received += bytes.length
      onProgress({ received, total })
      if (bytes.length === 0) throw new Error(`下载 ${name} 中断`)
    }
    const whole = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) { whole.set(chunk, offset); offset += chunk.length }
    return whole
  }

  const sums = new Map<string, string>()
  for (const line of new TextDecoder().decode(await fetchBytes('SHA256SUMS.txt')).split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+(\S+)$/)
    if (match?.[1] && match[2]) sums.set(match[2], match[1])
  }

  const files = new Map<string, Uint8Array>()
  for (const name of PLUGIN_FILES) {
    const bytes = name === 'main.js' ? await fetchChunked(name) : await fetchBytes(name)
    const expected = sums.get(name)
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`${name} 校验失败，已取消更新`)
    files.set(name, bytes)
  }
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))) as { id?: string, version?: string }
  if (manifest.id !== pluginId || manifest.version !== version) throw new Error('下载的安装包与当前插件不匹配，已取消更新')

  for (const [name, bytes] of files) await writeFile(join(pluginDir, `${name}.download`), bytes)
  for (const name of files.keys()) await rename(join(pluginDir, `${name}.download`), join(pluginDir, name))
}
