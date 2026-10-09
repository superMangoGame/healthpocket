import type { IncomingMessage, ServerResponse } from 'node:http'
import { LocalDatabase } from './database.ts'
import { LocalApi, HttpError, type LocalApiOptions } from './local-api.ts'

export const API_PREFIX = '/heathpocket/api'
export const PLUGIN_PREFIX = '/heathpocket'

/** Runs entirely inside the plugin. No subprocesses or runtime installation. */
export class BackendManager {
  readonly database: LocalDatabase
  private api: LocalApi
  private ready: Promise<void> | null = null
  private phase = 'off'
  private error: string | null = null
  private disposed = false

  constructor(packageRoot: string, apiOptions: LocalApiOptions = {}) {
    this.database = new LocalDatabase(packageRoot)
    this.api = new LocalApi(this.database, apiOptions)
  }

  status() {
    return { phase: this.phase, detail: this.error ?? (this.phase === 'running' ? '本地服务已就绪' : '正在准备本地数据'),
      runtime: 'typescript', dataDir: this.database.paths.dataDir, mode: this.database.paths.mode,
      error: this.error, appBuilt: true }
  }

  async ensureStarted() {
    if (this.disposed) throw new Error('插件已关闭')
    if (!this.ready) {
      this.phase = 'starting'
      this.ready = this.database.initialize().then(() => {
        this.phase = 'running'
        void this.api.reparseOutdated().catch((error: unknown) => console.error('[HealthPocket] reparse outdated failed', error))
        void this.api.slimGarminSnapshots().catch((error: unknown) => console.error('[HealthPocket] slim Garmin snapshots failed', error))
      }).catch((error: unknown) => {
        this.phase = 'failed'; this.error = error instanceof Error ? error.message : String(error)
        this.ready = null
        throw error
      })
    }
    await this.ready
    return this.status()
  }

  dispose(): void {
    this.disposed = true
    this.api.dispose()
    void (this.ready ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await this.api.settled()
      await this.database.close()
      this.phase = 'stopped'
    }).catch((error: unknown) => console.error('[HealthPocket] close failed', error))
  }

  async proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.ensureStarted()
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      await this.api.route(req, res, url.pathname.slice(API_PREFIX.length), url.searchParams)
    } catch (error) {
      if (!res.headersSent) {
        // An HttpError may carry extra fields (a Garmin stage, a hint). Spread
        // them so the client can render the failure instead of guessing at it.
        const extra = error instanceof HttpError ? error.extra : {}
        json(res, error instanceof HttpError ? error.status : 500,
          { ...extra, detail: error instanceof Error ? error.message : '本地请求失败' })
      } else res.destroy()
    }
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(payload)
}
