import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { HttpError } from './http-error.ts'
import { OWNER_ID, type LocalDatabase } from './database.ts'
import { extractPdfPages, type PageData, type ParsedFinding, type ParsedMeasurement } from './parser.ts'
import { MIN_TEXT_CHARS, RECORD_PARSER_VERSION, pagesFromText, parseRecordPages, readableLength, type RecordParse } from './record-parser.ts'
import type { DocumentExtraction, DocumentInput } from './ai.ts'

/**
 * 体检报告之外的就医资料：门诊病历、出院小结、CT 等影像、化验单。
 * 原文件按日期和类别归档；有文字层的 PDF 在本机解析，图片和扫描件交给用户配置的
 * 视觉模型转写。解析出的指标和诊断进入 health_measurements / health_findings 视图，
 * 与体检报告一起参与趋势、风险图谱和 AI 分析。
 */
export const RECORD_CATEGORIES = ['outpatient', 'inpatient', 'imaging', 'lab', 'prescription', 'other'] as const
export type RecordCategory = typeof RECORD_CATEGORIES[number]

export const RECORD_CATEGORY_LABELS: Record<RecordCategory, string> = {
  outpatient: '门诊病历', inpatient: '住院记录', imaging: '影像检查', lab: '检验报告', prescription: '处方用药', other: '其他记录',
}
export const recordSourceLabel = (category: RecordCategory, title: string | null) => {
  const label = RECORD_CATEGORY_LABELS[category] ?? '就医记录'
  return title ? `${label} · ${title}` : label
}

/**
 * 只收界面能直接预览的格式，并按文件头而不是扩展名判断。文件与应用同源提供，
 * 若放行 HTML、SVG 这类可执行内容，一份“病历”就能读到本地接口的访问令牌。
 */
const FILE_EXTENSIONS: Record<string, string> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }
export const MAX_RECORD_FILE_BYTES = 80 * 1024 * 1024
export const MAX_RECORD_FILES = 60
const MAX_THUMBNAIL_BYTES = 512 * 1024
const MAX_READABLE_BYTES = 6 * 1024 * 1024
const now = () => new Date().toISOString()

export function sniffFileType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** queued → processing → completed, or needs_ai (an image or scan waiting for the user to send it), or failed. */
export type ParseStatus = 'queued' | 'processing' | 'completed' | 'needs_ai' | 'failed'
export type ParseMethod = 'pdf_text' | 'ai_vision'
/** local: text layer only. auto: local first, then the vision model (chosen at upload). ai: the vision model, asked for on the record page. */
export type ParseMode = 'local' | 'auto' | 'ai'

type RecordFields = {
  id: string; profile_id: string; category: RecordCategory; title: string | null; record_date: string
  institution: string | null; department: string | null; notes: string | null; created_at: string; updated_at: string
}
type DbRecord = RecordFields & { owner_id: string }
type DbRecordFile = {
  id: string; owner_id: string; record_id: string; filename: string; sha256: string; mime_type: string; size_bytes: number
  has_thumbnail: number; has_readable: number; position: number; created_at: string
  text: string | null; parse_status: ParseStatus | null; parse_method: ParseMethod | null; parse_error: string | null; parsed_at: string | null; parser_version: string | null
}

export type RecordFileSummary = {
  id: string; record_id: string; filename: string; mime_type: string; size_bytes: number; has_thumbnail: boolean; created_at: string
  parse_status: ParseStatus | null; parse_method: ParseMethod | null; parse_error: string | null; parsed_at: string | null
  measurement_count: number; finding_count: number
}
export type MedicalRecord = RecordFields & { year: number; files: RecordFileSummary[] }
type StoredMeasurement = ParsedMeasurement & { id: string; file_id: string }
type StoredFinding = ParsedFinding & { id: string; file_id: string }
export type RecordDetail = RecordFields & { year: number; files: Array<RecordFileSummary & { text: string | null }>; measurements: StoredMeasurement[]; findings: StoredFinding[] }

export interface IncomingRecordFile { name: string; content: Uint8Array; thumbnail: Uint8Array | null; readable: Uint8Array | null }

export interface RecordStoreOptions {
  /** Runs database work on the API's mutation lane, so parsing never races a request. */
  serialize: <T>(label: string, work: () => Promise<T>) => Promise<T>
  recognize: (files: DocumentInput[], hint: string) => Promise<DocumentExtraction>
  readPdf?: (content: Uint8Array) => Promise<PageData[]>
  concurrency?: number
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HttpError(422, `${label}格式无效`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new HttpError(422, `${label}不能超过 ${max} 个字`)
  return trimmed || null
}

function recordDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(422, '请填写就诊或检查日期')
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || parsed.getUTCFullYear() < 1900) throw new HttpError(422, '日期无效')
  // A day of slack: the user's "today" can already be tomorrow in UTC.
  if (parsed.getTime() > Date.now() + 86_400_000) throw new HttpError(422, '日期不能晚于今天')
  return value
}

function recordFields(payload: Record<string, unknown>) {
  if (!RECORD_CATEGORIES.includes(payload.category as RecordCategory)) throw new HttpError(422, '请选择报告类别')
  return { category: payload.category as RecordCategory, record_date: recordDate(payload.record_date),
    title: optionalText(payload.title, '标题', 60), institution: optionalText(payload.institution, '医院', 60),
    department: optionalText(payload.department, '科室', 40), notes: optionalText(payload.notes, '备注', 2000) }
}

async function removeFile(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

const insertSql = (table: string, row: Record<string, unknown>) => {
  const keys = Object.keys(row)
  return `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((key) => `:${key}`).join(',')})`
}

export class RecordStore {
  private pending: Array<{ id: string; mode: ParseMode }> = []
  private running = new Set<Promise<void>>()
  private disposed = false
  private readonly concurrency: number
  private readonly readPdf: (content: Uint8Array) => Promise<PageData[]>

  constructor(private db: LocalDatabase, private options: RecordStoreOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 2)
    this.readPdf = options.readPdf ?? extractPdfPages
  }

  private get directory(): string { return join(this.db.paths.storageDir, 'records') }

  private filePath(file: Pick<DbRecordFile, 'sha256' | 'mime_type'>, variant: 'original' | 'thumbnail' | 'readable' = 'original'): string {
    const extension = FILE_EXTENSIONS[file.mime_type]
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !extension) throw new HttpError(400, '文件索引无效')
    return join(this.directory, variant === 'thumbnail' ? `${file.sha256}.thumb.jpg` : variant === 'readable' ? `${file.sha256}.read.jpg` : `${file.sha256}${extension}`)
  }

  /** Every stored path of a file, so a delete leaves nothing behind. */
  private paths(files: DbRecordFile[]): string[] {
    return files.flatMap((file) => [this.filePath(file), ...(file.has_thumbnail ? [this.filePath(file, 'thumbnail')] : []), ...(file.has_readable ? [this.filePath(file, 'readable')] : [])])
  }

  private assemble(records: DbRecord[]): MedicalRecord[] {
    if (!records.length) return []
    const ids = Object.fromEntries(records.map((record, index) => [`r${index}`, record.id]))
    const within = `record_id IN (${Object.keys(ids).map((key) => `:${key}`).join(',')})`
    const counts = (table: string) => new Map(this.db.rows<{ file_id: string; total: number }>(`SELECT file_id,count(*) AS total FROM ${table} WHERE ${within} GROUP BY file_id`, ids)
      .map((row) => [row.file_id, Number(row.total)]))
    const measurements = counts('record_measurements'); const findings = counts('record_findings')
    const files = new Map<string, RecordFileSummary[]>()
    for (const file of this.db.rows<DbRecordFile>(`SELECT * FROM record_files WHERE ${within} ORDER BY position,created_at`, ids)) {
      files.set(file.record_id, [...files.get(file.record_id) ?? [], this.summary(file, measurements.get(file.id) ?? 0, findings.get(file.id) ?? 0)])
    }
    return records.map(({ owner_id: _, ...record }) => ({ ...record, year: Number(record.record_date.slice(0, 4)), files: files.get(record.id) ?? [] }))
  }

  private summary(file: DbRecordFile, measurementCount: number, findingCount: number): RecordFileSummary {
    const { id, record_id, filename, mime_type, size_bytes, has_thumbnail, created_at, parse_status, parse_method, parse_error, parsed_at } = file
    return { id, record_id, filename, mime_type, size_bytes, has_thumbnail: Boolean(has_thumbnail), created_at,
      parse_status, parse_method, parse_error, parsed_at, measurement_count: measurementCount, finding_count: findingCount }
  }

  list(profile: string): MedicalRecord[] {
    return this.assemble(this.db.rows<DbRecord>('SELECT * FROM medical_records WHERE profile_id=:profile ORDER BY record_date DESC,created_at DESC', { profile }))
  }

  get(id: string): MedicalRecord {
    const record = this.db.one<DbRecord>('SELECT * FROM medical_records WHERE id=:id', { id })
    if (!record) throw new HttpError(404, '记录不存在')
    return this.assemble([record])[0]!
  }

  /** The record with each file's recognized text and everything parsed from it. */
  detail(id: string): RecordDetail {
    const record = this.get(id)
    const texts = new Map(this.db.rows<{ id: string; text: string | null }>('SELECT id,text FROM record_files WHERE record_id=:id', { id }).map((row) => [row.id, row.text]))
    const decode = (row: StoredMeasurement): StoredMeasurement => {
      if (typeof row.bbox !== 'string') return row
      try { return { ...row, bbox: JSON.parse(row.bbox) } } catch { return { ...row, bbox: null } }
    }
    return { ...record, files: record.files.map((file) => ({ ...file, text: texts.get(file.id) ?? null })),
      measurements: this.db.rows<StoredMeasurement & Record<string, unknown>>('SELECT * FROM record_measurements WHERE record_id=:id ORDER BY category,page', { id }).map(decode),
      findings: this.db.rows<StoredFinding & Record<string, unknown>>(`SELECT * FROM record_findings WHERE record_id=:id
        ORDER BY CASE severity WHEN 'abnormal' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END,page`, { id }) }
  }

  async create(profile: string, payload: Record<string, unknown>): Promise<MedicalRecord> {
    const record = { id: randomUUID(), owner_id: OWNER_ID, profile_id: profile, ...recordFields(payload), created_at: now(), updated_at: now() }
    this.db.run(insertSql('medical_records', record), record)
    await this.db.persist()
    return this.get(record.id)
  }

  async update(id: string, payload: Record<string, unknown>): Promise<MedicalRecord> {
    this.get(id)
    this.db.run(`UPDATE medical_records SET category=:category,record_date=:record_date,title=:title,institution=:institution,
      department=:department,notes=:notes,updated_at=:now WHERE id=:id`, { ...recordFields(payload), now: now(), id })
    await this.db.persist()
    return this.get(id)
  }

  async remove(id: string): Promise<void> {
    this.get(id)
    const files = this.db.rows<DbRecordFile>('SELECT * FROM record_files WHERE record_id=:id', { id })
    this.db.transaction(() => {
      for (const table of ['record_measurements', 'record_findings', 'record_files']) this.db.run(`DELETE FROM ${table} WHERE record_id=:id`, { id })
      this.db.run('DELETE FROM medical_records WHERE id=:id', { id })
    })
    await this.db.persist()
    for (const path of this.paths(files)) await removeFile(path)
  }

  async addFile(recordId: string, upload: IncomingRecordFile, options: { recognize: boolean } = { recognize: false }): Promise<RecordFileSummary> {
    const record = this.get(recordId)
    if (record.files.length >= MAX_RECORD_FILES) throw new HttpError(422, `每条记录最多 ${MAX_RECORD_FILES} 个文件`)
    if (!upload.content.length) throw new HttpError(400, '文件为空')
    if (upload.content.length > MAX_RECORD_FILE_BYTES) throw new HttpError(413, '单个文件不能超过 80 MB')
    const mime = sniffFileType(upload.content)
    if (!mime) throw new HttpError(415, '仅支持 PDF、JPG、PNG、WebP 文件')
    const sha = createHash('sha256').update(upload.content).digest('hex')
    const duplicate = this.db.one<{ record_id: string; title: string | null; record_date: string }>(`SELECT f.record_id,r.title,r.record_date
      FROM record_files f JOIN medical_records r ON r.id=f.record_id WHERE f.sha256=:sha`, { sha })
    if (duplicate) throw new HttpError(409, `该文件已在 ${duplicate.record_date}「${duplicate.title || '未命名记录'}」中`, { record_id: duplicate.record_id })
    const image = mime !== 'application/pdf'
    const jpeg = (bytes: Uint8Array | null, limit: number) => image && bytes && bytes.length <= limit && sniffFileType(bytes) === 'image/jpeg' ? bytes : null
    const thumbnail = jpeg(upload.thumbnail, MAX_THUMBNAIL_BYTES)
    // A downsized copy the vision model reads instead of a 12 MP phone photo.
    const readable = jpeg(upload.readable, MAX_READABLE_BYTES)
    const position = Number(this.db.one<{ next: number }>('SELECT coalesce(max(position),-1)+1 AS next FROM record_files WHERE record_id=:id', { id: recordId })?.next ?? 0)
    const file: DbRecordFile = { id: randomUUID(), owner_id: OWNER_ID, record_id: recordId,
      filename: basename(upload.name.replaceAll('\\', '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 255) || `file${FILE_EXTENSIONS[mime]}`,
      sha256: sha, mime_type: mime, size_bytes: upload.content.length, has_thumbnail: thumbnail ? 1 : 0, has_readable: readable ? 1 : 0, position, created_at: now(),
      text: null, parse_status: image && !options.recognize ? 'needs_ai' : 'queued', parse_method: null,
      parse_error: image && !options.recognize ? '图片需要用 AI 识别文字' : null, parsed_at: null, parser_version: null }
    await mkdir(this.directory, { recursive: true })
    const written = this.paths([file])
    try {
      await writeFile(this.filePath(file), upload.content, { mode: 0o600 })
      if (thumbnail) await writeFile(this.filePath(file, 'thumbnail'), thumbnail, { mode: 0o600 })
      if (readable) await writeFile(this.filePath(file, 'readable'), readable, { mode: 0o600 })
      this.db.transaction(() => {
        this.db.run(insertSql('record_files', file), file)
        this.db.run('UPDATE medical_records SET updated_at=:now WHERE id=:id', { now: now(), id: recordId })
      })
      await this.db.persist()
    } catch (error) {
      for (const path of written) await removeFile(path).catch(() => undefined)
      throw error
    }
    if (file.parse_status === 'queued') this.schedule(file.id, options.recognize ? 'auto' : 'local')
    return this.summary(file, 0, 0)
  }

  private file(recordId: string, fileId: string): DbRecordFile {
    const file = this.db.one<DbRecordFile>('SELECT * FROM record_files WHERE id=:id AND record_id=:record', { id: fileId, record: recordId })
    if (!file) throw new HttpError(404, '文件不存在')
    return file
  }

  async content(recordId: string, fileId: string, thumbnail: boolean): Promise<{ body: Buffer; mime: string; filename: string }> {
    const file = this.file(recordId, fileId)
    const useThumbnail = thumbnail && Boolean(file.has_thumbnail)
    try { return { body: await readFile(this.filePath(file, useThumbnail ? 'thumbnail' : 'original')), mime: useThumbnail ? 'image/jpeg' : file.mime_type, filename: file.filename } }
    catch { throw new HttpError(404, '原始文件不存在') }
  }

  async removeFileFrom(recordId: string, fileId: string): Promise<void> {
    const file = this.file(recordId, fileId)
    this.db.transaction(() => {
      for (const table of ['record_measurements', 'record_findings']) this.db.run(`DELETE FROM ${table} WHERE file_id=:id`, { id: file.id })
      this.db.run('DELETE FROM record_files WHERE id=:id', { id: file.id })
      this.db.run('UPDATE medical_records SET updated_at=:now WHERE id=:id', { now: now(), id: recordId })
    })
    await this.db.persist()
    for (const path of this.paths([file])) await removeFile(path)
  }

  /** Queues a file again: `ai` sends it to the vision model, `local` re-reads a PDF's text layer. */
  async requestParse(recordId: string, fileId: string, mode: 'local' | 'ai'): Promise<RecordFileSummary> {
    const file = this.file(recordId, fileId)
    if (mode === 'local' && file.mime_type !== 'application/pdf') throw new HttpError(422, '图片没有文字层，请用 AI 识别')
    if (file.parse_status === 'queued' || file.parse_status === 'processing') throw new HttpError(409, '这个文件正在识别中')
    this.db.run("UPDATE record_files SET parse_status='queued',parse_error=NULL WHERE id=:id", { id: file.id })
    await this.db.persist()
    this.schedule(file.id, mode)
    return this.get(recordId).files.find((item) => item.id === file.id)!
  }

  /**
   * After a restart: PDFs whose text was never read, was cut off, or was read by
   * older rules are parsed again locally. Interrupted AI recognition is marked
   * failed rather than retried, so no image leaves the computer without a click.
   */
  async resume(): Promise<number> {
    const ids = await this.options.serialize('records resume', async () => {
      this.db.run(`UPDATE record_files SET parse_status='failed',parse_error='上次识别因插件关闭而中断，请重新识别'
        WHERE parse_status IN ('queued','processing') AND mime_type<>'application/pdf'`)
      this.db.run("UPDATE record_files SET parse_status='needs_ai',parse_error='图片需要用 AI 识别文字' WHERE parse_status IS NULL AND mime_type<>'application/pdf'")
      const stale = this.db.rows<{ id: string }>(`SELECT id FROM record_files WHERE mime_type='application/pdf' AND (parse_status IS NULL OR parse_status IN ('queued','processing')
        OR (parse_status IN ('completed','needs_ai') AND coalesce(parse_method,'pdf_text')='pdf_text' AND coalesce(parser_version,'')<>:version))`, { version: RECORD_PARSER_VERSION })
      for (const { id } of stale) this.db.run("UPDATE record_files SET parse_status='queued' WHERE id=:id", { id })
      await this.db.persist()
      return stale.map((row) => row.id)
    })
    for (const id of ids) this.schedule(id, 'local')
    return ids.length
  }

  private schedule(id: string, mode: ParseMode): void {
    if (this.disposed) return
    this.pending.push({ id, mode })
    this.pump()
  }

  private pump(): void {
    while (!this.disposed && this.running.size < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!
      const task: Promise<void> = this.process(job.id, job.mode)
        .catch((error: unknown) => console.error('[HealthPocket] record parse failed', error))
        .finally(() => { this.running.delete(task); this.pump() })
      this.running.add(task)
    }
  }

  async settled(): Promise<void> {
    while (this.pending.length || this.running.size) await Promise.allSettled([...this.running])
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
  }

  private async process(id: string, mode: ParseMode): Promise<void> {
    const label = `record ${id.slice(0, 8)}`
    const start = await this.options.serialize(`${label} start`, async () => {
      const file = this.db.one<DbRecordFile>('SELECT * FROM record_files WHERE id=:id', { id })
      const record = file && this.db.one<DbRecord>('SELECT * FROM medical_records WHERE id=:id', { id: file.record_id })
      if (!file || !record) return null
      this.db.run("UPDATE record_files SET parse_status='processing',parse_error=NULL WHERE id=:id", { id })
      await this.db.persist()
      return { file, record }
    })
    if (!start) return
    const { file, record } = start
    const pdf = file.mime_type === 'application/pdf'
    let parsed: RecordParse | null = null; let method: ParseMethod = 'pdf_text'; let waiting: string | null = null
    try {
      const content = await readFile(this.filePath(file))
      if (mode !== 'ai' && pdf) {
        const pages = await this.readPdf(content)
        if (readableLength(pages) >= MIN_TEXT_CHARS) parsed = parseRecordPages(pages)
        else waiting = 'PDF 没有文字层（扫描件），需要用 AI 识别'
      } else if (mode !== 'ai') waiting = '图片需要用 AI 识别文字'
      if (!parsed && mode !== 'local') {
        const readable = !pdf && file.has_readable ? await readFile(this.filePath(file, 'readable')).catch(() => null) : null
        const extraction = await this.options.recognize([{ data: readable ?? content, mediaType: readable ? 'image/jpeg' : file.mime_type }],
          `这是一份${RECORD_CATEGORY_LABELS[record.category]}${record.title ? `（${record.title}）` : ''}，日期 ${record.record_date}。`)
        const rows = extraction.measurements.map((row) => [row.name, row.value, row.unit, row.reference, row.flag].filter(Boolean).join(' '))
        parsed = parseRecordPages(pagesFromText([extraction.text, ...rows].join('\n')), extraction.diagnoses)
        parsed.institution ||= extraction.institution
        method = 'ai_vision'; waiting = null
      }
    } catch (error) {
      await this.options.serialize(`${label} failed`, async () => {
        if (!this.db.one('SELECT id FROM record_files WHERE id=:id', { id })) return
        this.db.run("UPDATE record_files SET parse_status='failed',parse_error=:error WHERE id=:id", { id, error: error instanceof Error ? error.message.slice(0, 600) : '识别失败' })
        await this.db.persist()
      })
      return
    }
    await this.options.serialize(`${label} finish`, async () => {
      if (!this.db.one('SELECT id FROM record_files WHERE id=:id', { id })) return
      // A local re-read of a scan must not throw away what the vision model already read.
      if (!parsed && file.parse_method === 'ai_vision' && file.parsed_at) {
        this.db.run("UPDATE record_files SET parse_status='completed' WHERE id=:id", { id })
        await this.db.persist(); return
      }
      this.db.transaction(() => {
        for (const table of ['record_measurements', 'record_findings']) this.db.run(`DELETE FROM ${table} WHERE file_id=:id`, { id })
        for (const item of parsed?.measurements ?? []) {
          const row = { id: randomUUID(), owner_id: OWNER_ID, record_id: file.record_id, file_id: id, ...item }
          this.db.run(insertSql('record_measurements', row), row)
        }
        for (const item of parsed?.findings ?? []) {
          const row = { id: randomUUID(), owner_id: OWNER_ID, record_id: file.record_id, file_id: id, ...item }
          this.db.run(insertSql('record_findings', row), row)
        }
        this.db.run(`UPDATE record_files SET text=:text,parse_status=:status,parse_method=:method,parse_error=:error,parsed_at=:now,parser_version=:version WHERE id=:id`, {
          id, text: parsed?.text.slice(0, 60_000) || null, status: parsed ? 'completed' : 'needs_ai', method: parsed ? method : null, error: waiting, now: now(), version: RECORD_PARSER_VERSION })
        // Fill in the hospital only when the user left it blank.
        if (parsed?.institution) this.db.run('UPDATE medical_records SET institution=:institution WHERE id=:id AND institution IS NULL', { id: file.record_id, institution: parsed.institution.slice(0, 60) })
      })
      await this.db.persist()
    })
  }

  /** Deletes every record row for 清除全部数据; returns the files to unlink once the database is saved. */
  clearAll(): string[] {
    const paths = this.paths(this.db.rows<DbRecordFile>('SELECT * FROM record_files'))
    for (const table of ['record_measurements', 'record_findings', 'record_files', 'medical_records']) this.db.run(`DELETE FROM ${table}`)
    this.pending = []
    return paths
  }

  async unlink(paths: string[]): Promise<void> {
    for (const path of paths) await removeFile(path)
  }

  /** Records, their parsed data and original files for the backup archive; derived images are rebuilt from the originals and left out. */
  async exportArchive(): Promise<{ records: Array<Record<string, unknown>>; files: Record<string, Uint8Array> }> {
    const records = this.db.rows<DbRecord>('SELECT * FROM medical_records ORDER BY record_date')
    const files = this.db.rows<DbRecordFile>('SELECT * FROM record_files ORDER BY record_id,position')
    const archive: Record<string, Uint8Array> = {}
    const entries = new Map<string, Array<Record<string, unknown>>>()
    for (const file of files) {
      const path = `records/${file.sha256}${FILE_EXTENSIONS[file.mime_type]}`
      try { archive[path] = await readFile(this.filePath(file)) }
      catch { throw new HttpError(409, `原始文件缺失，无法生成完整备份：${file.filename}`) }
      const { measurement_count: _m, finding_count: _f, ...summary } = this.summary(file, 0, 0)
      entries.set(file.record_id, [...entries.get(file.record_id) ?? [], { ...summary, sha256: file.sha256, text: file.text, path }])
    }
    const parsed = (table: string, id: string) => this.db.rows(`SELECT * FROM ${table} WHERE record_id=:id`, { id }).map(({ owner_id: _, ...row }) => row)
    return { records: records.map(({ owner_id: _, ...record }) => ({ ...record, files: entries.get(record.id) ?? [],
      measurements: parsed('record_measurements', record.id), findings: parsed('record_findings', record.id) })), files: archive }
  }
}
