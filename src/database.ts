import initSqlJs, { type BindParams, type Database, type SqlValue, type SqlJsStatic } from 'sql.js'
import wasmBinary from 'sql.js/dist/sql-wasm.wasm'
import { existsSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { METRICS } from './metrics.ts'

const OWNER_ID = 'local-owner'

export interface DataPaths {
  mode: 'repo' | 'home'
  dataDir: string
  dbPath: string
  legacyDbPath: string
  storageDir: string
  exportDir: string
  modelDir: string
}

export function resolveDataPaths(packageRoot: string): DataPaths {
  const configured = process.env.HEALTHPOCKET_DATA_DIR?.trim()
  if (configured) return buildPaths('home', resolve(configured), join(resolve(configured), 'healthpocket.db'))
  const rootDatabase = join(packageRoot, 'healthpocket.db')
  const repoReports = join(packageRoot, 'data', 'reports')
  if (existsSync(rootDatabase) || existsSync(repoReports)) return buildPaths('repo', join(packageRoot, 'data'), existsSync(rootDatabase) ? rootDatabase : join(packageRoot, 'data', 'healthpocket.db'))
  const dataDir = resolve(process.env.HEALTHPOCKET_HOME?.trim() || join(homedir(), '.healthpocket'))
  return buildPaths('home', dataDir, join(dataDir, 'healthpocket.db'))
}

function buildPaths(mode: 'repo' | 'home', dataDir: string, dbPath: string): DataPaths {
  return { mode, dataDir, dbPath: join(dataDir, 'healthpocket-ts.db'), legacyDbPath: dbPath, storageDir: join(dataDir, 'reports-ts'), exportDir: join(dataDir, 'exports'), modelDir: join(dataDir, 'models', 'human-atlas-v1') }
}

function sqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'string' || value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

export class LocalDatabase {
  readonly paths: DataPaths
  private db: Database | null = null
  private saveQueue: Promise<void> = Promise.resolve()
  private lockHeld = false
  private sql: SqlJsStatic | null = null
  private committed: Uint8Array | null = null

  constructor(packageRoot: string) {
    this.paths = resolveDataPaths(packageRoot)
  }

  async initialize(): Promise<void> {
    if (this.db) return
    mkdirSync(this.paths.storageDir, { recursive: true })
    mkdirSync(this.paths.exportDir, { recursive: true })
    mkdirSync(this.paths.modelDir, { recursive: true })
    this.acquireLock()
    try {
    const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasmBinary).buffer })
    this.sql = SQL
    if (!existsSync(this.paths.dbPath) && existsSync(this.paths.legacyDbPath)) {
      if (existsSync(`${this.paths.legacyDbPath}-wal`) || existsSync(`${this.paths.legacyDbPath}-journal`)) {
        throw new Error('旧数据库仍有未合并的事务，请先关闭原 Python 服务后重试')
      }
      const legacy = readFileSync(this.paths.legacyDbPath)
      if (legacy.length) copyFileSync(this.paths.legacyDbPath, this.paths.dbPath)
    }
    const initial = existsSync(this.paths.dbPath) && readFileSync(this.paths.dbPath).byteLength > 0 ? readFileSync(this.paths.dbPath) : undefined
    this.db = initial ? new SQL.Database(initial) : new SQL.Database()
    this.committed = this.db.export()
    this.db.run('PRAGMA foreign_keys = ON')
    this.createSchema()
    // Copy legacy PDFs too, so deletions in the new runtime do not break rollback.
    for (const report of this.rows<{ id: string; sha256: string; stored_path: string }>('SELECT id,sha256,stored_path FROM reports')) {
      if (!/^[a-f0-9]{64}$/.test(report.sha256)) throw new Error('旧报告文件索引无效，迁移已停止')
      const destination = join(this.paths.storageDir, `${report.sha256}.pdf`)
      if (report.stored_path !== destination && existsSync(report.stored_path) && !existsSync(destination)) copyFileSync(report.stored_path, destination)
      this.run('UPDATE reports SET stored_path=:path WHERE id=:id', { path: destination, id: report.id })
    }
    this.ensureSeedData()
    this.run("UPDATE reports SET parse_status='failed' WHERE parse_status IN ('queued','processing')")
    this.run("UPDATE parse_jobs SET status='failed',progress=100,error='上次解析因插件关闭而中断，请重新解析',finished_at=:now WHERE status IN ('queued','processing')", { now: new Date().toISOString() })
    await this.persist()
    } catch (error) { this.db?.close(); this.db = null; this.releaseLock(); throw error }
  }

  async close(): Promise<void> {
    await this.saveQueue.catch(() => undefined)
    this.db?.close()
    this.db = null
    this.releaseLock()
  }

  run(sql: string, params: Record<string, unknown> = {}): void {
    const bound = Object.fromEntries(Object.entries(params).map(([key, value]) => [key.startsWith(':') ? key : `:${key}`, sqlValue(value)])) as BindParams
    this.requireDb().run(sql, bound)
  }

  rows<T extends Record<string, unknown>>(sql: string, params: Record<string, unknown> = {}): T[] {
    const bound = Object.fromEntries(Object.entries(params).map(([key, value]) => [key.startsWith(':') ? key : `:${key}`, sqlValue(value)])) as BindParams
    const statement = this.requireDb().prepare(sql)
    try {
      statement.bind(bound)
      const result: T[] = []
      while (statement.step()) result.push(statement.getAsObject() as T)
      return result
    } finally {
      statement.free()
    }
  }

  one<T extends Record<string, unknown>>(sql: string, params: Record<string, unknown> = {}): T | null {
    return this.rows<T>(sql, params)[0] ?? null
  }

  transaction(work: () => void): void {
    const db = this.requireDb()
    db.run('BEGIN IMMEDIATE')
    try { work(); db.run('COMMIT') } catch (error) { db.run('ROLLBACK'); throw error }
  }

  persist(): Promise<void> {
    const snapshot = Buffer.from(this.requireDb().export())
    const destination = this.paths.dbPath
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
      mkdirSync(dirname(destination), { recursive: true })
      const temporary = `${destination}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600, flush: true })
      await rename(temporary, destination)
      this.committed = snapshot
    }).catch((error: unknown) => {
      // Failed saves must not leave the API showing uncommitted in-memory data.
      if (this.sql && this.committed && this.db) {
        this.db.close(); this.db = new this.sql.Database(this.committed); this.db.run('PRAGMA foreign_keys = ON')
      }
      throw error
    })
    return this.saveQueue
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('本地数据库尚未初始化')
    return this.db
  }

  private acquireLock(): void {
    const path = `${this.paths.dbPath}.lock`
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8'))
      let alive = false
      if (Number.isSafeInteger(pid) && pid > 0) {
        alive = true
        try { process.kill(pid, 0) } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      }
      if (alive) throw new Error('此数据目录已由另一个健康口袋实例打开，请关闭该实例后重试')
      unlinkSync(path)
    }
    const descriptor = openSync(path, 'wx', 0o600)
    try { writeFileSync(descriptor, String(process.pid)); this.lockHeld = true } finally { closeSync(descriptor) }
  }

  private releaseLock(): void {
    if (!this.lockHeld) return
    try { unlinkSync(`${this.paths.dbPath}.lock`) } finally { this.lockHeld = false }
  }

  private createSchema(): void {
    const columns = this.rows<{ name: string }>('PRAGMA table_info(reports)')
    if (columns.length && !columns.some((column) => column.name === 'profile_id')) this.run('ALTER TABLE reports ADD COLUMN profile_id TEXT')
    this.requireDb().run(`
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, relation TEXT NOT NULL, birth_date TEXT, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT, filename TEXT NOT NULL, stored_path TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, page_count INTEGER, exam_date TEXT, year INTEGER, institution TEXT, template_type TEXT NOT NULL, parse_status TEXT NOT NULL, parser_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
      CREATE TABLE IF NOT EXISTS parse_jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, report_id TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS measurements (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, report_id TEXT NOT NULL, canonical_id TEXT NOT NULL, raw_name TEXT NOT NULL, abbreviation TEXT, value_numeric REAL, value_text TEXT, unit TEXT, ref_low REAL, ref_high REAL, ref_text TEXT, flag TEXT, status TEXT NOT NULL, category TEXT NOT NULL, organ TEXT, anatomy_id TEXT, confidence REAL NOT NULL, page INTEGER NOT NULL, bbox TEXT, raw_text TEXT NOT NULL, FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, report_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, category TEXT NOT NULL, organ TEXT, anatomy_id TEXT, section TEXT, source TEXT, severity TEXT NOT NULL, page INTEGER NOT NULL, confidence REAL NOT NULL, FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS metric_definitions (canonical_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, display_name TEXT NOT NULL, abbreviation TEXT, aliases TEXT NOT NULL, value_type TEXT NOT NULL, canonical_unit TEXT, category TEXT NOT NULL, organ TEXT);
      CREATE TABLE IF NOT EXISTS ai_settings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_insights (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, dimension TEXT NOT NULL, year_from INTEGER, year_to INTEGER, question TEXT, model TEXT NOT NULL, summary TEXT NOT NULL, content_json TEXT NOT NULL, evidence_json TEXT NOT NULL, data_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS garmin_settings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, email TEXT NOT NULL, region TEXT NOT NULL, profile_id TEXT NOT NULL, authenticated INTEGER NOT NULL DEFAULT 0, display_name TEXT, last_sync_at TEXT, last_sync_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
      CREATE TABLE IF NOT EXISTS garmin_daily (profile_id TEXT NOT NULL, date TEXT NOT NULL, steps INTEGER, distance_m REAL, active_calories REAL, total_calories REAL, resting_hr REAL, min_hr REAL, max_hr REAL, average_stress REAL, max_stress REAL, body_battery REAL, body_battery_low REAL, body_battery_high REAL, spo2_avg REAL, spo2_low REAL, respiration_avg REAL, respiration_sleep REAL, intensity_minutes REAL, sleep_seconds REAL, deep_sleep_seconds REAL, light_sleep_seconds REAL, rem_sleep_seconds REAL, awake_sleep_seconds REAL, sleep_score REAL, hrv_last_night REAL, hrv_weekly_avg REAL, hrv_5min_high REAL, hrv_status TEXT, training_status TEXT, training_readiness REAL, vo2_max REAL, fitness_age REAL, raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(profile_id,date), FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS garmin_activities (profile_id TEXT NOT NULL, activity_id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, duration_seconds REAL NOT NULL, distance_m REAL, calories REAL, average_hr REAL, max_hr REAL, elevation_gain REAL, training_effect REAL, anaerobic_training_effect REAL, raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(profile_id,activity_id), FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS ix_reports_profile_id ON reports(profile_id); CREATE INDEX IF NOT EXISTS ix_reports_year ON reports(year); CREATE INDEX IF NOT EXISTS ix_measurements_report_id ON measurements(report_id); CREATE INDEX IF NOT EXISTS ix_measurements_canonical_id ON measurements(canonical_id); CREATE INDEX IF NOT EXISTS ix_findings_report_id ON findings(report_id); CREATE INDEX IF NOT EXISTS ix_parse_jobs_report_id ON parse_jobs(report_id);
      CREATE INDEX IF NOT EXISTS ix_ai_insights_profile_id ON ai_insights(profile_id); CREATE INDEX IF NOT EXISTS ix_ai_insights_created_at ON ai_insights(created_at);
      CREATE INDEX IF NOT EXISTS ix_garmin_daily_profile_date ON garmin_daily(profile_id,date); CREATE INDEX IF NOT EXISTS ix_garmin_activities_profile_date ON garmin_activities(profile_id,date);
    `)
    // 人体结构树字段：旧库补列，旧数据由启动时的自动重新解析填充。
    const additions: Array<[string, string]> = [['measurements', 'anatomy_id'], ['findings', 'anatomy_id'], ['findings', 'section'], ['findings', 'source']]
    for (const [table, column] of additions) {
      if (!this.rows<{ name: string }>(`PRAGMA table_info(${table})`).some((item) => item.name === column)) this.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
  }

  private ensureSeedData(): void {
    const now = new Date().toISOString()
    let defaultProfile = this.one<{ id: string }>('SELECT id FROM profiles WHERE owner_id = :owner AND is_default = 1 ORDER BY created_at LIMIT 1', { owner: OWNER_ID })
    if (!defaultProfile) {
      const id = randomUUID()
      this.run('INSERT INTO profiles (id, owner_id, name, relation, birth_date, is_default, created_at, updated_at) VALUES (:id, :owner, :name, :relation, NULL, 1, :now, :now)', { id, owner: OWNER_ID, name: '我', relation: 'self', now })
      defaultProfile = { id }
    }
    this.run('UPDATE reports SET profile_id = :profile WHERE profile_id IS NULL', { profile: defaultProfile.id })
    for (const item of METRICS) this.run(`INSERT OR IGNORE INTO metric_definitions (canonical_id, owner_id, display_name, abbreviation, aliases, value_type, canonical_unit, category, organ)
      VALUES (:canonical_id, :owner, :display_name, :abbreviation, :aliases, :value_type, :canonical_unit, :category, :organ)`, { ...item, owner: OWNER_ID })
  }
}

export { OWNER_ID }
