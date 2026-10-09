import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as scheduleTimer, clearTimeout as cancelTimer } from 'node:timers'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { pipeUIMessageStreamToResponse } from 'ai'
import { json } from './backend.ts'
import { LocalDatabase, OWNER_ID } from './database.ts'
import { Aggregation, reportSummary, RULES_VERSION, type DbReport, type DbMeasurement } from './aggregation.ts'
import { METRICS, ORGAN_LABELS } from './metrics.ts'
import { ANATOMY } from '../web/lib/anatomy.ts'
import { inspectPdf, parsePdf, type ParsedReport } from './parser.ts'
import { buildDailyInsights, type DailyInsights } from './daily-insights.ts'
import { AiService, type AiModelRunner, type InsightRequest, type SecretStore } from './ai.ts'
import { GarminActionError, GarminService, GarminSyncBusyError, type GarminClientFactory, type GarminServiceOptions } from './garmin.ts'

export const PARSER_VERSION = '2026.10-anatomy.1'
/**
 * An error the client should render verbatim. `extra` carries the fields the
 * settings page needs to explain a failure - which stage of the Garmin login
 * fell over, and what the user can do about it - and is spread into the JSON
 * error body by `BackendManager.proxy` alongside `detail`.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Row = {}) { super(message) }
}
type Row = Record<string, unknown>
const now = () => new Date().toISOString()
const MAX_PDF_BYTES = 80 * 1024 * 1024
export const DEFAULT_PARSE_CONCURRENCY = 3

export interface LocalApiOptions {
  parseConcurrency?: number
  parser?: (content: Uint8Array) => Promise<ParsedReport>
  secretStore?: SecretStore
  aiRunner?: AiModelRunner
  garminClientFactory?: GarminClientFactory
  /** Deadlines for the Garmin actions, injectable so a test need not wait 45 s. */
  garminOptions?: GarminServiceOptions
  /** How long one Garmin write may hold the lane before it is released. */
  garminLaneStallMs?: number
  /**
   * Whether the user turned on the experimental Garmin sync in the Obsidian
   * settings tab. Read on every request so toggling it needs no reload.
   * Defaults to enabled so tests and the standalone runtime keep working.
   */
  garminEnabled?: () => boolean
  /** Compares the running version with the published one; only the Obsidian plugin supplies it. */
  checkUpdate?: () => Promise<UpdateInfo>
  /** Downloads the latest release over the installed files; only the Obsidian plugin supplies it. */
  updater?: Updater
  /** The running plugin version, shown on the settings page. */
  appVersion?: string
}

export interface UpdateStatus {
  phase: 'idle' | 'downloading' | 'ready' | 'error'
  version: string | null
  received: number
  total: number
  error: string | null
}

export interface Updater {
  status(): UpdateStatus
  /** Starts downloading the latest release in the background and returns at once. */
  start(): Promise<UpdateStatus>
  /** Reloads the plugin so the downloaded version takes effect. */
  restart(): void
}

export interface UpdateInfo {
  current: string
  latest: string
  hasUpdate: boolean
  releasesPage: string
}

class MemorySecretStore implements SecretStore {
  private values = new Map<string, string>()
  get(id: string): string | null { return this.values.get(id) ?? null }
  set(id: string, value: string): void { this.values.set(id, value) }
}

/**
 * Garmin sign-in runs on its own lane instead of the main mutation queue.
 * Everything mutating is serialized so the in-memory SQLite snapshot never sees
 * two writers at once, but that queue also carries genuinely slow work - an AI
 * insight generation is a single LLM call that can run for minutes, and report
 * imports/parsing and a 30-day Garmin sync are not fast either. A login queued
 * behind one of those never even opens a socket to Garmin, so the UI waits out
 * its own request timeout and reports a network failure for what is really a
 * busy queue. Garmin's own routes stay serialized among themselves, which is all
 * they need: they touch nothing but the garmin_* tables, and persist() already
 * serializes the actual file writes.
 */
const GARMIN_LANE = /^\/garmin\//

/**
 * How long one Garmin write may hold the lane before the next one is let
 * through anyway.
 *
 * Serializing the lane is what keeps two logins from racing each other, but a
 * queue that only advances when its head settles turns *one* wedged request
 * into a permanently dead button: every later attempt queues behind something
 * that may never answer, so it times out too, and its own diagnostics entry is
 * never written. The watchdog bounds that blast radius - the original request
 * is still awaited by its caller, but it stops being everyone else's problem.
 *
 * Comfortably longer than the backend's own 45 s login ceiling, so a merely
 * slow-but-alive login still gets its answer reported as a login failure.
 */
const GARMIN_LANE_STALL_MS = 90_000

export class LocalApi {
  private aggregation: Aggregation
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private garminQueue: Promise<unknown> = Promise.resolve()
  /** What the main lane is doing right now, for /health diagnostics. */
  private runningMutation: { label: string; startedAt: number } | null = null
  private waitingMutations = 0
  private runningGarmin = 0
  /** How many times the lane watchdog had to free a wedged request. */
  private garminStalls = 0
  private pendingJobs: string[] = []
  private runningJobs = new Set<Promise<void>>()
  private activeJobs = 0
  private readonly parseConcurrency: number
  private readonly parser: (content: Uint8Array) => Promise<ParsedReport>
  private readonly ai: AiService
  private readonly garmin: GarminService
  private readonly garminLaneStallMs: number
  private readonly garminEnabled: () => boolean
  private readonly checkUpdate: (() => Promise<UpdateInfo>) | null
  private readonly updater: Updater | null
  private readonly appVersion: string | null
  private disposed = false
  constructor(private db: LocalDatabase, options: LocalApiOptions = {}) {
    this.aggregation = new Aggregation(db)
    this.parseConcurrency = Math.max(1, Math.min(6, Math.floor(options.parseConcurrency ?? DEFAULT_PARSE_CONCURRENCY)))
    this.parser = options.parser ?? parsePdf
    const secrets = options.secretStore ?? new MemorySecretStore()
    this.ai = new AiService(db, secrets, options.aiRunner)
    this.garmin = new GarminService(db, secrets, options.garminClientFactory, options.garminOptions)
    this.garminLaneStallMs = options.garminLaneStallMs ?? GARMIN_LANE_STALL_MS
    this.garminEnabled = options.garminEnabled ?? (() => true)
    this.checkUpdate = options.checkUpdate ?? null
    this.updater = options.updater ?? null
    this.appVersion = options.appVersion ?? null
  }
  dispose(): void {
    this.disposed = true
    this.garmin.dispose()
  }
  async settled(): Promise<void> {
    while (this.pendingJobs.length || this.runningJobs.size) {
      await Promise.allSettled([...this.runningJobs])
    }
    await Promise.all([this.mutationQueue.catch(() => undefined), this.garminQueue.catch(() => undefined)])
  }

  /** Queue state for /health, so a stalled lane is visible instead of guessed at. */
  queueStatus(): Row {
    return {
      active: this.runningMutation ? { ...this.runningMutation, running_ms: Date.now() - this.runningMutation.startedAt } : null,
      waiting: this.waitingMutations,
      garmin_active: this.runningGarmin,
      garmin_stalls: this.garminStalls,
    }
  }

  private serializeMutation<T>(label: string, work: () => Promise<T>): Promise<T> {
    const task = this.mutationQueue.catch(() => undefined).then(async () => {
      this.waitingMutations -= 1
      this.runningMutation = { label, startedAt: Date.now() }
      try { return await work() } finally { this.runningMutation = null }
    })
    this.waitingMutations += 1
    this.mutationQueue = task
    return task
  }

  private serializeGarmin<T>(work: () => Promise<T>): Promise<T> {
    const task = this.garminQueue.catch(() => undefined).then(async () => {
      this.runningGarmin += 1
      try { return await work() } finally { this.runningGarmin -= 1 }
    })
    // The lane opens when this task settles *or* when the stall watchdog fires,
    // whichever comes first. Nothing is abandoned: `task` still answers its own
    // caller with a real error (every Garmin action carries its own deadline);
    // the watchdog only stops a wedged request from blocking everyone after it.
    let watchdog: NodeJS.Timeout | undefined
    const stalled = new Promise<void>((resolve) => {
      watchdog = scheduleTimer(() => { this.garminStalls += 1; this.garmin.recordLaneStall(this.garminLaneStallMs); resolve() }, this.garminLaneStallMs)
    })
    const settled = task.catch(() => undefined).finally(() => { if (watchdog) cancelTimer(watchdog) })
    this.garminQueue = Promise.race([settled, stalled])
    return task
  }

  async route(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    if (this.disposed) throw new HttpError(503, '插件已关闭')
    // With the experimental Garmin sync switched off, only the status read stays
    // reachable (so the UI can explain how to turn it on); nothing touches Garmin.
    if (GARMIN_LANE.test(path) && !this.garminEnabled() && !(path === '/garmin/settings' && req.method === 'GET')) {
      throw new HttpError(403, 'Garmin 同步未开启，请在 Obsidian 设置 → HealthPocket 中启用')
    }
    // Reads and streaming AI calls answer immediately; Garmin has its own lane;
    // everything else mutates shared tables and waits its turn.
    if (req.method === 'GET' || (req.method === 'POST' && ['/ai/chat', '/ai/models', '/ai/test', '/daily/advice'].includes(path))) await this.dispatch(req, res, path, query)
    else if (GARMIN_LANE.test(path)) await this.serializeGarmin(() => this.dispatch(req, res, path, query))
    else await this.serializeMutation(`${req.method ?? 'POST'} ${path}`, () => this.dispatch(req, res, path, query))
  }

  private dailyInsights(query: URLSearchParams): DailyInsights {
    const from = query.get('from'); const to = query.get('to')
    for (const value of [from, to]) if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(422, '日期范围无效')
    return buildDailyInsights(this.db, this.profile(query.get('profile_id')), from! <= to! ? { from: from!, to: to! } : { from: to!, to: from! })
  }

  private profile(id: string | null): string {
    const row = id ? this.db.one<{ id: string }>('SELECT id FROM profiles WHERE id=:id AND owner_id=:owner', { id, owner: OWNER_ID })
      : this.db.one<{ id: string }>('SELECT id FROM profiles WHERE owner_id=:owner ORDER BY is_default DESC,created_at LIMIT 1', { owner: OWNER_ID })
    if (!row) throw new HttpError(404, '健康档案不存在')
    return row.id
  }

  private report(id: string): DbReport {
    const row = this.db.one<DbReport>('SELECT * FROM reports WHERE id=:id', { id })
    if (!row) throw new HttpError(404, '报告不存在')
    return row
  }

  private filePath(report: DbReport): string {
    if (!/^[a-f0-9]{64}$/.test(report.sha256)) throw new HttpError(400, '报告文件索引无效')
    return join(this.db.paths.storageDir, `${report.sha256}.pdf`)
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET'
    if (path === '/health' && method === 'GET') return json(res, 200, { status: 'ok', parser_version: PARSER_VERSION, rules_version: RULES_VERSION, runtime: 'typescript', queue: this.queueStatus() })
    if (path === '/ai/providers' && method === 'GET') return json(res, 200, this.ai.providers())
    if (path === '/ai/models' && method === 'POST') {
      try { return json(res, 200, await this.ai.models(await readJson(req))) }
      catch (error) { throw new HttpError(422, modelError(error)) }
    }
    if (path === '/ai/settings' && method === 'GET') return json(res, 200, this.ai.settings())
    if (path === '/ai/settings' && method === 'PUT') {
      try { return json(res, 200, await this.ai.saveSettings(await readJson(req))) }
      catch (error) { throw new HttpError(422, error instanceof Error ? error.message : '模型配置无效') }
    }
    if (path === '/ai/test' && method === 'POST') {
      try { await this.ai.test(); return json(res, 200, { ok: true }) }
      catch (error) { throw new HttpError(502, modelError(error)) }
    }
    if (path === '/ai/chat' && method === 'POST') {
      const payload = await readJson(req, 512 * 1024)
      const profile = this.profile(typeof payload.profile_id === 'string' ? payload.profile_id : null)
      const range = payload.garmin_range as { from?: unknown; to?: unknown } | null | undefined
      const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      const garminRange = range && isDate(range.from) && isDate(range.to) ? { from: range.from, to: range.to } : null
      const stream = await this.ai.chat({ profile_id: profile, messages: payload.messages, garmin_range: garminRange, include_garmin: this.garminEnabled() })
      await pipeUIMessageStreamToResponse({ response: res, stream })
      return
    }
    if (path === '/ai/insights' && method === 'GET') return json(res, 200, this.ai.list(this.profile(query.get('profile_id'))))
    if (path === '/ai/insights' && method === 'POST') {
      const payload = await readJson(req)
      const profile = this.profile(typeof payload.profile_id === 'string' ? payload.profile_id : null)
      const dimension = payload.dimension
      if (!['comprehensive', 'annual', 'trend', 'organ', 'custom'].includes(String(dimension))) throw new HttpError(422, '请选择有效的分析维度')
      const yearFrom = nullableYear(payload.year_from); const yearTo = nullableYear(payload.year_to)
      if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) throw new HttpError(422, '起始年份不能晚于结束年份')
      const question = typeof payload.question === 'string' ? payload.question.trim().slice(0, 1000) || null : null
      if (dimension === 'custom' && !question) throw new HttpError(422, '请输入希望分析的问题')
      const conversation = chatContext(payload.conversation)
      try { return json(res, 201, await this.ai.generate({ profile_id: profile, dimension, year_from: yearFrom, year_to: yearTo, question, conversation } as InsightRequest)) }
      catch (error) { throw new HttpError(502, modelError(error)) }
    }
    if (path === '/garmin/settings' && method === 'GET') return json(res, 200, { ...this.garmin.settings(), feature_enabled: this.garminEnabled() })
    if (path === '/garmin/settings' && method === 'PUT') {
      const payload = await readJson(req)
      try { return json(res, 200, await this.garmin.connect(payload, this.profile(typeof payload.profile_id === 'string' ? payload.profile_id : null))) }
      catch (error) { throw garminHttpError(error instanceof GarminSyncBusyError ? error.status : 422, error, 'Garmin 配置无效') }
    }
    if (path === '/garmin/settings' && method === 'DELETE') {
      try { return json(res, 200, await this.garmin.disconnect()) }
      catch (error) { throw garminHttpError(error instanceof GarminSyncBusyError ? error.status : 500, error, '断开 Garmin 失败') }
    }
    if (path === '/garmin/settings/mfa' && method === 'POST') {
      const payload = await readJson(req)
      try { return json(res, 200, await this.garmin.verifyMfa(typeof payload.code === 'string' ? payload.code : '', typeof payload.method === 'string' ? payload.method : undefined)) }
      catch (error) { throw garminHttpError(422, error, '验证码校验失败') }
    }
    if (path === '/garmin/settings/mfa' && method === 'DELETE') return json(res, 200, this.garmin.cancelMfa())
    if (path === '/garmin/settings/mfa/resend' && method === 'POST') {
      try { return json(res, 200, await this.garmin.resendMfa()) }
      catch (error) { throw garminHttpError(422, error, '重新发送验证码失败') }
    }
    // The request log behind the settings page's "查看请求记录" panel. It holds
    // no credentials: only which action ran, which hop it reached, how long it
    // took and the error text the user already saw. `queue` is what tells
    // "queued behind another request" apart from "stuck on the network".
    if (path === '/garmin/diagnostics' && method === 'GET') return json(res, 200, { ...this.garmin.diagnosticLog(), queue: this.queueStatus() })
    if (path === '/garmin/dashboard' && method === 'GET') {
      const from = query.get('from') ?? undefined
      const to = query.get('to') ?? undefined
      for (const value of [from, to]) if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(422, '日期范围无效')
      return json(res, 200, this.garmin.dashboard(this.profile(query.get('profile_id')), { from, to }))
    }
    if (path === '/daily/insights' && method === 'GET') {
      return json(res, 200, { ...this.dailyInsights(query), advice: this.ai.latestAdvice(this.profile(query.get('profile_id'))) })
    }
    if (path === '/daily/advice' && method === 'POST') {
      const payload = await readJson(req)
      const params = new URLSearchParams(Object.entries(payload).filter(([, value]) => typeof value === 'string') as Array<[string, string]>)
      const insights = this.dailyInsights(params)
      try { return json(res, 200, await this.ai.advise(this.profile(params.get('profile_id')), insights.context)) }
      catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)) }
    }
    if (path === '/garmin/sync' && method === 'POST') {
      const payload = await readJson(req)
      const { month, from, to } = payload
      if (month !== undefined && (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) throw new HttpError(422, '同步月份无效')
      for (const value of [from, to]) if (value !== undefined && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) throw new HttpError(422, '同步日期无效')
      const range = { month: month as string | undefined, from: from as string | undefined, to: to as string | undefined }
      const profileId = this.profile(typeof payload.profile_id === 'string' ? payload.profile_id : null)
      // A long backfill runs in the background: it would otherwise hold the
      // Garmin lane for minutes and outlive the page's own request timeout.
      if (payload.background === true) {
        try { return json(res, 202, this.garmin.startSync(profileId, range)) }
        catch (error) { throw garminHttpError(error instanceof GarminSyncBusyError ? error.status : 422, error, 'Garmin 同步失败') }
      }
      try { return json(res, 200, await this.garmin.sync(profileId, range)) }
      catch (error) { throw garminHttpError(error instanceof GarminSyncBusyError ? error.status : 502, error, 'Garmin 同步失败') }
    }
    const insightRoute = /^\/ai\/insights\/([^/]+)$/.exec(path)
    if (insightRoute && method === 'DELETE') {
      await this.ai.delete(insightRoute[1]!, this.profile(query.get('profile_id')))
      res.writeHead(204); res.end(); return
    }
    if (path === '/profiles' && method === 'GET') return json(res, 200, this.db.rows(`SELECT p.id,p.name,p.relation,p.birth_date,p.is_default,p.created_at,
      (SELECT count(*) FROM reports r WHERE r.profile_id=p.id) AS report_count FROM profiles p WHERE p.owner_id=:owner ORDER BY p.is_default DESC,p.created_at`, { owner: OWNER_ID }).map((item) => ({ ...item, is_default: Boolean(item.is_default) })))
    if (path === '/profiles' && method === 'POST') {
      const payload = await readJson(req)
      const name = typeof payload.name === 'string' ? payload.name.trim() : ''
      const relation = payload.relation ?? 'other'; const birth = payload.birth_date ?? null
      if (!name || name.length > 40) throw new HttpError(422, '档案姓名需为 1–40 个字符')
      if (typeof relation !== 'string' || !['spouse', 'parent', 'child', 'other'].includes(relation)) throw new HttpError(422, '请选择有效的家庭关系')
      if (birth !== null && (typeof birth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birth) || !Number.isFinite(Date.parse(birth)) || new Date(birth).toISOString().slice(0, 10) !== birth)) throw new HttpError(422, '出生日期无效')
      const record = { id: randomUUID(), owner_id: OWNER_ID, name, relation, birth_date: birth, is_default: false, created_at: now(), updated_at: now() }
      this.insert('profiles', record); await this.db.persist()
      return json(res, 201, { ...record, report_count: 0 })
    }
    if (path === '/reports' && method === 'GET') return json(res, 200, this.aggregation.reports(this.profile(query.get('profile_id'))).map(reportSummary))
    if (path === '/reports' && method === 'POST') return this.upload(req, res)
    if (path === '/dashboard' && method === 'GET') return json(res, 200, this.aggregation.dashboard(this.profile(query.get('profile_id'))))
    if (path === '/dashboard/risk-detail' && method === 'GET') {
      const year = Number(query.get('year')); if (!query.has('year') || !Number.isInteger(year)) throw new HttpError(422, '请选择有效年份')
      const detail = this.aggregation.riskDetail(this.profile(query.get('profile_id')), query.get('domain_id') ?? '', year)
      if (!detail) throw new HttpError(404, '风险域不存在')
      return json(res, 200, detail)
    }
    if (path === '/metrics/definitions' && method === 'GET') {
      if (!query.has('profile_id')) return json(res, 200, METRICS)
      const ids = new Set(this.aggregation.trendRows(this.profile(query.get('profile_id'))).map((item) => item.canonical_id))
      return json(res, 200, METRICS.filter((item) => ids.has(item.canonical_id)))
    }
    if (path === '/metrics/trends' && method === 'GET') {
      const profile = this.profile(query.get('profile_id'))
      let trend
      try { trend = this.aggregation.trend(profile, query.get('canonical_id') ?? '', query.get('unit')) }
      catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '趋势读取失败') }
      if (!trend) throw new HttpError(404, '指标不存在')
      return json(res, 200, trend)
    }
    if (path === '/organs' && method === 'GET') return json(res, 200, Object.entries(ORGAN_LABELS).map(([id, label]) => ({ id, label })))
    if (path === '/anatomy' && method === 'GET') return json(res, 200, ANATOMY)
    const timeline = /^\/organs\/([^/]+)\/timeline$/.exec(path)
    if (timeline && method === 'GET') {
      const data = this.aggregation.timeline(this.profile(query.get('profile_id')), timeline[1]!)
      if (!data) throw new HttpError(404, '器官不存在')
      return json(res, 200, data)
    }
    const job = /^\/parse-jobs\/([^/]+)$/.exec(path)
    if (job && method === 'GET') {
      const row = this.db.one('SELECT * FROM parse_jobs WHERE id=:id', { id: job[1] })
      if (!row) throw new HttpError(404, '解析任务不存在')
      return json(res, 200, row)
    }
    const reportRoute = /^\/reports\/([^/]+)(?:\/(file|reparse))?$/.exec(path)
    if (reportRoute) {
      const report = this.report(reportRoute[1]!); const action = reportRoute[2]
      if (action === 'file' && method === 'GET') {
        let content: Buffer
        try { content = await readFile(this.filePath(report)) } catch { throw new HttpError(404, '报告文件不存在') }
        res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'content-length': content.length,
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(report.filename)}` }); res.end(content); return
      }
      if (action === 'reparse' && method === 'POST') {
        const job = this.createJob(report.id); await this.db.persist(); json(res, 200, job); this.scheduleJob(String(job.id)); return
      }
      if (!action && method === 'GET') return json(res, 200, { ...reportSummary(report),
        measurements: this.db.rows<DbMeasurement>('SELECT * FROM measurements WHERE report_id=:id ORDER BY category,page', { id: report.id }).map(decodeBbox),
        findings: this.db.rows(`SELECT * FROM findings WHERE report_id=:id
          ORDER BY CASE severity WHEN 'abnormal' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END, page`, { id: report.id }) })
      if (!action && method === 'DELETE') {
        this.removeReports([report]); await this.db.persist(); await removeFile(this.filePath(report)); res.writeHead(204); res.end(); return
      }
    }
    if (path === '/update-check' && method === 'GET') {
      if (!this.checkUpdate) throw new HttpError(404, '当前运行环境不支持检查更新')
      try { return json(res, 200, await this.checkUpdate()) } catch (error) { throw new HttpError(502, error instanceof Error ? error.message : String(error)) }
    }
    if (path === '/app-info' && method === 'GET') return json(res, 200, { version: this.appVersion, can_update: Boolean(this.updater) })
    if (path.startsWith('/update-') && path !== '/update-check' && !this.updater) throw new HttpError(404, '当前运行环境不支持自动更新')
    if (path === '/update-install' && method === 'GET') return json(res, 200, this.updater!.status())
    if (path === '/update-install' && method === 'POST') return json(res, 200, await this.updater!.start())
    if (path === '/update-restart' && method === 'POST') {
      if (this.updater!.status().phase !== 'ready') throw new HttpError(409, '新版本尚未下载完成')
      this.updater!.restart(); return json(res, 200, { ok: true })
    }
    if (path === '/exports' && method === 'POST') return this.export(res)
    if (path === '/data' && method === 'DELETE') {
      const reports = this.db.rows<DbReport>('SELECT * FROM reports')
      this.removeReports(reports); this.db.run('DELETE FROM ai_insights'); this.db.run('DELETE FROM garmin_daily'); this.db.run('DELETE FROM garmin_activities')
      this.db.run('UPDATE garmin_settings SET last_sync_at=NULL,last_sync_error=NULL,updated_at=:now', { now: now() }); await this.db.persist()
      for (const report of reports) await removeFile(this.filePath(report))
      res.writeHead(204); res.end(); return
    }
    throw new HttpError(404, '接口不存在')
  }

  private insert(table: 'reports' | 'profiles' | 'parse_jobs' | 'measurements' | 'findings', record: Row): void {
    // Table names and keys originate only from internal records, never request keys.
    const keys = Object.keys(record)
    this.db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((key) => `:${key}`).join(',')})`, record)
  }

  /** 去掉旧版本保存的佳明时间序列，数据库只需瘦身一次。 */
  slimGarminSnapshots(): Promise<number> {
    return this.serializeGarmin(() => this.garmin.slimStoredSnapshots())
  }

  /** 解析规则升级后，把旧版本解析的报告在后台重新解析一遍。 */
  async reparseOutdated(): Promise<number> {
    const stale = await this.serializeMutation('reparse outdated', async () => {
      const reports = this.db.rows<{ id: string }>(`SELECT id FROM reports WHERE parser_version<>:version AND parse_status IN ('completed','partial','failed')`, { version: PARSER_VERSION })
      if (!reports.length) return []
      const jobs: Row[] = []
      this.db.transaction(() => { for (const report of reports) jobs.push(this.createJob(report.id)) })
      await this.db.persist()
      return jobs
    })
    for (const job of stale) this.scheduleJob(String(job.id))
    return stale.length
  }

  private createJob(reportId: string): Row {
    const job = { id: randomUUID(), owner_id: OWNER_ID, report_id: reportId, status: 'queued', progress: 0, error: null, created_at: now(), started_at: null, finished_at: null }
    this.insert('parse_jobs', job)
    this.db.run("UPDATE reports SET parse_status='queued',updated_at=:now WHERE id=:id", { now: now(), id: reportId })
    return job
  }

  private async upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, '上传格式无效')
    const bytes = await readBody(req, MAX_PDF_BYTES + 1024 * 1024)
    let form: FormData
    try { form = await new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }).formData() }
    catch { throw new HttpError(400, '上传表单无效') }
    const file = form.get('file'); const profileField = form.get('profile_id')
    if (!file || typeof file === 'string') throw new HttpError(400, '请选择 PDF 文件')
    if (file.size > MAX_PDF_BYTES) throw new HttpError(413, 'PDF 不能超过 80 MB')
    if (file.type && !['application/pdf', 'application/octet-stream'].includes(file.type)) throw new HttpError(415, '文件类型不是 PDF')
    const content = Buffer.from(await file.arrayBuffer())
    if (content.subarray(0, 5).toString() !== '%PDF-') throw new HttpError(400, '仅支持有效的 PDF 文件')
    const profile = this.profile(typeof profileField === 'string' ? profileField : null)
    const sha = createHash('sha256').update(content).digest('hex')
    const duplicate = this.db.one<{ id: string }>('SELECT id FROM reports WHERE sha256=:sha', { sha })
    if (duplicate) return json(res, 409, { detail: { message: '该报告已导入', report_id: duplicate.id } })
    let pageCount: number
    try { pageCount = await inspectPdf(content) } catch { throw new HttpError(400, 'PDF 无法读取、已加密或超过 300 页') }
    const report = { id: randomUUID(), owner_id: OWNER_ID, profile_id: profile, filename: basename(file.name.replaceAll('\\', '/')).slice(0, 255) || 'report.pdf',
      stored_path: join(this.db.paths.storageDir, `${sha}.pdf`), sha256: sha, size_bytes: content.length, page_count: pageCount, exam_date: null,
      year: null, institution: null, template_type: 'unknown', parse_status: 'queued', parser_version: PARSER_VERSION, created_at: now(), updated_at: now() }
    await writeFile(report.stored_path, content, { mode: 0o600 })
    let job!: Row
    try {
      this.db.transaction(() => { this.insert('reports', report); job = this.createJob(report.id) })
      await this.db.persist()
    } catch (error) { await removeFile(report.stored_path).catch(() => undefined); throw error }
    json(res, 201, { report: reportSummary(report), job }); this.scheduleJob(String(job.id))
  }

  private scheduleJob(id: string): void {
    this.pendingJobs.push(id)
    this.pumpJobs()
  }

  private pumpJobs(): void {
    while (this.activeJobs < this.parseConcurrency && this.pendingJobs.length) {
      const id = this.pendingJobs.shift()!
      this.activeJobs++
      const task = this.processJob(id)
        .catch((error: unknown) => console.error('[HealthPocket] parse persistence failed', error))
        .finally(() => {
          this.activeJobs--
          this.runningJobs.delete(task)
          this.pumpJobs()
        })
      this.runningJobs.add(task)
    }
  }

  private async processJob(id: string): Promise<void> {
    const source = await this.serializeMutation(`parse ${id.slice(0, 8)} start`, async () => {
      const job = this.db.one<{ report_id: string }>('SELECT report_id FROM parse_jobs WHERE id=:id', { id })
      if (!job) return null
      const report = this.db.one<DbReport>('SELECT * FROM reports WHERE id=:id', { id: job.report_id })
      if (!report) return null
      this.db.run("UPDATE parse_jobs SET status='processing',progress=10,started_at=:now WHERE id=:id", { now: now(), id })
      this.db.run("UPDATE reports SET parse_status='processing' WHERE id=:id", { id: report.id })
      await this.db.persist()
      return { reportId: report.id, path: this.filePath(report) }
    })
    if (!source) return
    try {
      const parsed = await this.parser(await readFile(source.path))
      const completed = parsed.template_type !== 'unknown' && parsed.measurements.filter((item) => item.confidence >= 0.8).length + parsed.findings.length >= 5
      const status = completed ? 'completed' : 'partial'
      await this.serializeMutation(`parse ${id.slice(0, 8)} finish`, async () => {
        if (!this.db.one('SELECT id FROM reports WHERE id=:id', { id: source.reportId }) || !this.db.one('SELECT id FROM parse_jobs WHERE id=:id', { id })) return
        this.db.transaction(() => {
          this.db.run('DELETE FROM measurements WHERE report_id=:id', { id: source.reportId })
          this.db.run('DELETE FROM findings WHERE report_id=:id', { id: source.reportId })
          for (const item of parsed.measurements) this.insert('measurements', { id: randomUUID(), owner_id: OWNER_ID, report_id: source.reportId, ...item })
          for (const item of parsed.findings) this.insert('findings', { id: randomUUID(), owner_id: OWNER_ID, report_id: source.reportId, ...item })
          this.db.run(`UPDATE reports SET page_count=:page_count,exam_date=:exam_date,year=:year,institution=:institution,template_type=:template_type,
            parse_status=:status,parser_version=:version,updated_at=:now WHERE id=:id`,
          { page_count: parsed.page_count, exam_date: parsed.exam_date, year: parsed.year, institution: parsed.institution, template_type: parsed.template_type, status, version: PARSER_VERSION, now: now(), id: source.reportId })
          this.db.run('UPDATE parse_jobs SET status=:status,progress=100,error=:error,finished_at=:now WHERE id=:id', {
            status, error: completed ? null : '部分字段无法可靠识别；扫描型 PDF 需先生成可搜索文字层，低置信度结果不参与健康状态聚合', now: now(), id })
        })
        await this.db.persist()
      })
    } catch (error) {
      await this.serializeMutation(`parse ${id.slice(0, 8)} failed`, async () => {
        if (!this.db.one('SELECT id FROM parse_jobs WHERE id=:id', { id })) return
        this.db.run("UPDATE parse_jobs SET status='failed',progress=100,error=:error,finished_at=:now WHERE id=:id", { error: error instanceof Error ? error.message.slice(0, 1200) : '解析失败', now: now(), id })
        this.db.run("UPDATE reports SET parse_status='failed',updated_at=:now WHERE id=:id", { now: now(), id: source.reportId })
        await this.db.persist()
      })
    }
  }

  private removeReports(reports: DbReport[]): void {
    this.db.transaction(() => {
      const profiles = [...new Set(reports.map((report) => report.profile_id))]
      for (const profile of profiles) this.db.run('DELETE FROM ai_insights WHERE profile_id=:profile', { profile })
      for (const report of reports) {
        for (const table of ['parse_jobs', 'measurements', 'findings']) this.db.run(`DELETE FROM ${table} WHERE report_id=:id`, { id: report.id })
        this.db.run('DELETE FROM reports WHERE id=:id', { id: report.id })
      }
    })
  }

  private async export(res: ServerResponse): Promise<void> {
    const reports = this.db.rows<DbReport>('SELECT * FROM reports ORDER BY year')
    const payload = { format: 'healthpocket-export', version: 2, created_at: now(), parser_version: PARSER_VERSION, rules_version: RULES_VERSION,
      metric_definitions: METRICS, profiles: this.db.rows('SELECT id,name,relation,birth_date,is_default FROM profiles').map((row) => ({ ...row, is_default: Boolean(row.is_default) })),
      reports: reports.map((report) => ({ ...reportSummary(report), measurements: this.db.rows<DbMeasurement>('SELECT * FROM measurements WHERE report_id=:id', { id: report.id }).map(decodeBbox), findings: this.db.rows('SELECT * FROM findings WHERE report_id=:id', { id: report.id }) })),
      garmin: {
        settings: this.db.rows('SELECT email,region,profile_id,display_name,last_sync_at,updated_at FROM garmin_settings'),
        daily: this.db.rows('SELECT * FROM garmin_daily ORDER BY profile_id,date'),
        activities: this.db.rows('SELECT * FROM garmin_activities ORDER BY profile_id,date'),
      } }
    const files: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(payload, null, 2)) }
    for (const report of reports) {
      try { files[`reports/${report.sha256}.pdf`] = await readFile(this.filePath(report)) }
      catch { throw new HttpError(409, `原始报告文件缺失，无法生成完整备份：${report.filename}`) }
    }
    const content = Buffer.from(zipSync(files, { level: 6 }))
    res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-length': content.length,
      'content-disposition': `attachment; filename="healthpocket-export-${now().slice(0, 10)}.zip"` }); res.end(content)
  }
}

function decodeBbox(item: DbMeasurement): DbMeasurement {
  if (typeof item.bbox !== 'string') return item
  try { return { ...item, bbox: JSON.parse(item.bbox) } } catch { return { ...item, bbox: null } }
}
async function removeFile(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, '请求内容过大')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length
    if (size > limit) throw new HttpError(413, '请求内容过大')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Row> {
  const body = await readBody(req, limit)
  try { const parsed: unknown = JSON.parse(body.toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed as Row }
  catch { throw new HttpError(400, 'JSON 格式无效') }
}

function nullableYear(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const year = Number(value)
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new HttpError(422, '年份无效')
  return year
}

function modelError(error: unknown): string {
  const message = error instanceof Error ? error.message : '模型调用失败'
  if (/timeout|timed out|abort/i.test(message)) return '模型响应超时，请检查服务状态或稍后重试'
  if (/fetch|network|connect|ECONN|ENOTFOUND/i.test(message)) return '无法连接模型服务，请检查地址和网络'
  if (/401|403|api.?key|unauthorized|forbidden/i.test(message)) return '模型服务拒绝访问，请检查 API Key 和账号权限'
  return message.slice(0, 500)
}

/**
 * Turns a Garmin failure into an HTTP error that explains itself.
 *
 * The settings page shows `stage` and `hint` next to the message; without them
 * every failure - a wrong region, a rate limit, a dead proxy - arrived as one
 * anonymous sentence, which is what made "登录没有任何反应" so hard to read.
 */
function garminHttpError(status: number, error: unknown, fallback: string): HttpError {
  if (error instanceof GarminActionError) {
    return new HttpError(status, error.message, { stage: error.stage, hint: error.hint ?? null, failed_at: new Date().toISOString() })
  }
  return new HttpError(status, error instanceof Error ? error.message : fallback)
}

function chatContext(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HttpError(422, '对话上下文格式无效')
  const messages = value.slice(-8).map((item) => {
    if (!item || typeof item !== 'object') throw new HttpError(422, '对话上下文格式无效')
    const row = item as Record<string, unknown>
    if (row.role !== 'user' && row.role !== 'assistant') throw new HttpError(422, '对话角色无效')
    const role: 'user' | 'assistant' = row.role
    const content = typeof row.content === 'string' ? row.content.trim() : ''
    if (!content || content.length > 1200) throw new HttpError(422, '单条对话内容需为 1–1200 个字符')
    return { role, content }
  })
  if (messages.reduce((total, item) => total + item.content.length, 0) > 6000) throw new HttpError(422, '对话上下文过长，请开始新话题')
  return messages
}
