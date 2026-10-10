import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { createUIMessageStream, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Model, Provider, ProviderMap } from '@opencode-ai/models'
import { inspectPdf, parsePdf, extractMeasurements, extractFindings, metricStatus, detectTemplate, extractInstitution } from '../src/parser.ts'
import { extractLayout } from '../src/report-layout.ts'
import { classifyAnatomy, organOfAnatomy, organConceptIds } from '../web/lib/anatomy.ts'
import { BackendManager, API_PREFIX } from '../src/backend.ts'
import { LocalDatabase } from '../src/database.ts'
import { Aggregation } from '../src/aggregation.ts'
import { authorizedRequest } from '../src/local-security.ts'
import { handleStatic, APP_PREFIX } from '../src/static.ts'
import { AiService, OpenSourceAiRunner, describeModelError, type AiModelRunner, type AiSettings, type InsightOutput } from '../src/ai.ts'
import { AiCatalog } from '../src/ai-catalog.ts'
import { garminFetch, macOsGarminProxy, GarminLoginError, type GarminClientFactory, type GarminClientLike } from '../src/garmin.ts'
import { cachedGarminOAuthConsumer, createGarminAuthFlow, forgetGarminOAuthConsumer, OAUTH_CONSUMER_URL, obtainGarminOAuthConsumer, REQUEST_BUDGET, REQUEST_TIMEOUT, setGarminConsumerStore, type GarminAuthEndpoints, type GarminConsumerStore } from '../src/garmin-auth.ts'
import { GarminAuthError } from '@dofek/garmin-connect'
import type { GarminTokens } from '@dofek/garmin-connect/types'

function syntheticPdf(examDate = '2025-06-01'): Buffer {
  const stream = `BT /F1 12 Tf 50 760 Td (${examDate}) Tj 0 -24 Td ( BMI 23.5 kg/m2 18.5-23.9) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

test('Garmin transport bypasses the Chromium renderer fetch', async () => {
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: () => { throw new TypeError('Illegal invocation') } })
  try {
    const response = await garminFetch('data:application/json,%7B%7D')
    assert.equal(response.status, 200)
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch })
  }
})

test('Garmin transport stops waiting on its own budget and names the slow step', async () => {
  const server = createServer(() => { /* Deliberately never send a response. */ })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const startedAt = Date.now()
    const init = Object.assign({}, { [REQUEST_BUDGET]: 1_000 }) as RequestInit
    await assert.rejects(
      () => garminFetch(`http://127.0.0.1:${address.port}/mobile/api/login`, init),
      /提交 Garmin 账号密码超时/,
    )
    // The point of the wall clock: it must give up on its own, not after undici's
    // multi-minute header timeout, or the caller waits for nothing at all.
    assert.ok(Date.now() - startedAt < 6_000, 'the request should settle on its own budget')
  } finally {
    server.closeAllConnections(); server.close()
  }
})

test('Garmin transport bounds a stalled response body, not just the headers', async () => {
  // Headers, then silence. `fetch()` resolves at the headers, so a per-call timer
  // that stops there leaves the body able to hang the login forever - which is
  // what "提交账号密码超过 45 秒仍没有响应" was: a hop that had answered but never
  // finished answering, with nothing left to time it out.
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
    res.write('{"responseStatus":{"type":"MFA_REQ')
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const startedAt = Date.now()
    const init = Object.assign({}, { [REQUEST_BUDGET]: 1_000 }) as RequestInit
    const response = await garminFetch(`http://127.0.0.1:${address.port}/mobile/api/login`, init)
    await assert.rejects(() => response.json(), /提交 Garmin 账号密码超时/)
    assert.ok(Date.now() - startedAt < 8_000, 'the body must settle on its own clock')
  } finally {
    server.closeAllConnections(); server.close()
  }
})

test('Garmin transport reports a caller-side abort as a transport failure', async () => {
  const server = createServer(() => { /* Deliberately never send a response. */ })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    await assert.rejects(
      () => garminFetch(`http://127.0.0.1:${address.port}/stalled`, { signal: AbortSignal.timeout(50) }),
      /连接失败|超时/,
    )
  } finally {
    server.closeAllConnections(); server.close()
  }
})

test('ported rules retain flags, split blood pressure, female screening and negation', () => {
  assert.equal(metricStatus(3, null, '↑', 0, 10), 'abnormal')
  assert.equal(metricStatus(null, '阴性', null, null, null), 'normal')
  assert.equal(detectTemplate('健康体检报告导读'), 'health100-2024-2025')
  const page = { number: 4, words: [], text: [
    '2、血压:正常高值血压:(129/85mmHg) 我国将收缩压120~139mmHg和(或)舒张压80~89 mmHg',
    '白带清洁度 Ⅲ Ⅰ/Ⅱ', 'HPV 16（高危型） 阴性 阴性', 'HPV 52（高危型） 阳性 阴性',
    'TCT检测：未见上皮内病变及恶性病变(NILM),轻度炎症,建议炎症消退后复查。',
    '糖链抗原125测定（CA125） 3.34 U/ml 0-35', '糖链抗原15-3测定（CA15-3） 3.21 U/ml 0-28',
    '左侧乳腺结节（多发）可能（BI-RADS 2类）',
  ].join('\n') }
  const values = Object.fromEntries(extractMeasurements([page], 'health100-2024-2025').map((item) => [item.canonical_id, item]))
  assert.equal(values.systolic_bp?.value_numeric, 129); assert.equal(values.systolic_bp?.ref_low, 120)
  assert.equal(values.diastolic_bp?.value_numeric, 85); assert.equal(values.diastolic_bp?.status, 'attention')
  assert.equal(values.hpv?.value_text, '阳性'); assert.equal(values.tct?.status, 'attention')
  assert.equal(values.vaginal_cleanliness?.value_numeric, 3); assert.equal(values.vaginal_cleanliness?.status, 'abnormal')
  assert.equal(values.ca125?.value_numeric, 3.34); assert.equal(values.ca153?.value_numeric, 3.21); assert.equal(values.birads?.value_numeric, 2)
  const findings = extractFindings([{ number: 1, words: [], text: '心脏杂音 未见异常\n肺-呼吸音 未闻及异常\n眼底:异常\n异异常常指指标标解解读读\n脂肪肝大多数无任何症状' }])
  assert.deepEqual(findings.map((item) => item.organ), ['eyes'])
})

test('anatomy tree classifies by content first and section context second', () => {
  assert.equal(classifyAnatomy({ text: '尿白细胞', context: '尿常规' }), 'urinary.urine')
  assert.equal(classifyAnatomy({ text: '白细胞计数', context: '血常规' }), 'hematologic')
  assert.equal(classifyAnatomy({ text: '白细胞', context: '尿常规' }), 'urinary.urine')
  assert.equal(classifyAnatomy({ text: '宫颈:轻糜样改变', context: '妇科常规检查' }), 'reproductive.female.cervix')
  assert.equal(classifyAnatomy({ text: '甘油三酯增高' }), 'cardiovascular.lipids')
  assert.equal(classifyAnatomy({ text: '血清乳酸脱氢酶' }), 'cardiovascular.heart')
  assert.equal(classifyAnatomy({ text: '外痔' }), 'digestive.intestine')
  assert.equal(classifyAnatomy({ text: '完全无法识别的描述' }), 'body')
  assert.equal(organOfAnatomy('reproductive.female.adnexa'), 'ovary')
  assert.equal(organOfAnatomy('body'), 'other')
  assert.deepEqual(organConceptIds().heart, ['FMA7088'])
})

test('generic layout parses an unknown institution into anatomy-linked findings', () => {
  const pages = [
    { number: 1, words: [], text: ['某某市第一人民医院体检中心', '性别: 女', '体检结论', '1、心电轴左偏', '2、肺尖胸膜帽增厚', '3、外痔', '4、附件 未扪及明显异常'].join('\n') },
    { number: 2, words: [], text: ['分项报告', '【妇科】', '项目 结果', '宫颈 未见明显异常', '小结 未见明显异常', '【生化检测】', '项目 简称 结果 提示 单位 参考区间',
      '血清乳酸脱氢酶 LDH 115 ↓ U/L 120-250', '血清尿酸 UA 300 - μmol/L 150-420', '【肝胆脾胰双肾彩超】', '项目 结果', '小结 肝脏彩超:肝脏声像图未见明显异常'].join('\n') },
  ]
  const layout = extractLayout(pages)
  assert.equal(layout.detailStartPage, 2)
  assert.deepEqual(layout.sections.map((item) => item.title), ['妇科', '生化检测', '肝胆脾胰双肾彩超'])
  assert.equal(extractInstitution(pages[0]!.text), '某某市第一人民医院体检中心')
  const findings = extractFindings(pages, { sex: 'female', layout })
  const abnormal = findings.filter((item) => item.severity !== 'normal').map((item) => [item.source, item.anatomy_id, item.title])
  assert.deepEqual(abnormal, [
    ['conclusion', 'cardiovascular.heart', '心电轴左偏'],
    ['conclusion', 'respiratory.thorax', '肺尖胸膜帽增厚'],
    ['conclusion', 'digestive.intestine', '外痔'],
    ['item', 'cardiovascular.heart', '血清乳酸脱氢酶 偏低'],
  ])
  const normal = findings.filter((item) => item.severity === 'normal').map((item) => item.anatomy_id)
  assert.deepEqual(normal, ['reproductive.female', 'digestive.liver'])
})

test('PDF extraction uses the bundled runtime without a worker file', async () => {
  const bytes = syntheticPdf()
  assert.equal(await inspectPdf(bytes), 1)
  const parsed = await parsePdf(bytes)
  assert.equal(parsed.exam_date, '2025-06-01')
  assert.equal(parsed.page_count, 1)
  assert.equal(parsed.template_type, 'unknown')
  await assert.rejects(inspectPdf(Buffer.from('%PDF-broken')))
})

test('API lifecycle, isolation, persisted restart, export, and embedded atlas', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-runtime-test-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const backend = new BackendManager(folder)
  const server = createServer((req, res) => {
    const operation = req.url?.startsWith(APP_PREFIX) ? handleStatic(req, res) : backend.proxy(req, res)
    void operation.catch((error: unknown) => { res.writeHead(500); res.end(String(error)) })
  })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const call = (path: string, init?: RequestInit) => fetch(`${origin}${API_PREFIX}${path}`, init)
    assert.equal((await (await call('/health')).json()).runtime, 'typescript')
    const profiles = await (await call('/profiles')).json(); assert.equal(profiles.length, 1)
    assert.equal((await call('/reports?profile_id=missing')).status, 404)
    assert.equal((await call('/profiles', { method: 'POST', body: '{}' })).status, 422)
    const relative = await (await call('/profiles', { method: 'POST', body: JSON.stringify({ name: '测试档案', relation: 'parent' }) })).json()
    const makeForm = () => { const form = new FormData(); form.append('file', new Blob([new Uint8Array(syntheticPdf())], { type: 'application/pdf' }), 'test.pdf'); form.append('profile_id', relative.id); return form }
    const upload = await call('/reports', { method: 'POST', body: makeForm() }); assert.equal(upload.status, 201, await upload.clone().text())
    const { report, job } = await upload.json()
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await (await call(`/parse-jobs/${job.id}`)).json()
      if (['completed', 'partial', 'failed'].includes(current.status)) { assert.equal(current.status, 'partial', current.error); break }
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.notEqual(attempt, 99, 'parse job did not settle')
    }
    assert.equal((await call('/reports', { method: 'POST', body: makeForm() })).status, 409)
    assert.equal((await (await call(`/reports?profile_id=${profiles[0].id}`)).json()).length, 0)
    assert.equal((await (await call(`/reports?profile_id=${relative.id}`)).json()).length, 1)
    assert.equal((await (await call(`/reports/${report.id}`)).json()).year, 2025)
    assert.deepEqual(Buffer.from(await (await call(`/reports/${report.id}/file`)).arrayBuffer()), syntheticPdf())
    const zip = unzipSync(new Uint8Array(await (await call('/exports', { method: 'POST' })).arrayBuffer()))
    assert.ok(zip['manifest.json']); assert.ok(zip[`reports/${report.sha256}.pdf`])
    const dashboard = await (await call(`/dashboard?profile_id=${relative.id}`)).json()
    assert.equal(dashboard.report_count, 1); assert.equal(dashboard.risk_matrix.length, 11)
    const rival = new LocalDatabase(folder); await assert.rejects(rival.initialize(), /另一个/)
    const html = await fetch(`${origin}${APP_PREFIX}/`); assert.equal(html.status, 200); assert.match(await html.text(), /健康口袋/)
    const head = await fetch(`${origin}${APP_PREFIX}/`, { method: 'HEAD' }); assert.equal(await head.text(), '')
    const atlas = await (await fetch(`${origin}${APP_PREFIX}/models/human-atlas/atlas.json`)).json()
    assert.equal(atlas.parts.length, 2234); assert.ok(atlas.parts.every((part: { nameZh?: string }) => part.nameZh))
    const binName = (await readdir(join(process.env.HEALTHPOCKET_TEST_ROOT!, 'web/public/models/human-atlas'))).find((name) => name.endsWith('.bin.gz'))!
    const model = Buffer.from(await (await fetch(`${origin}${APP_PREFIX}/models/human-atlas/${binName}`)).arrayBuffer())
    assert.ok(gunzipSync(model).length > 0)
    assert.equal((await call(`/reports/${report.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await call(`/reports/${report.id}`)).status, 404)
    assert.equal((await call(`/parse-jobs/${job.id}`)).status, 404)
    await backend.database.close()
    const reopened = new LocalDatabase(folder); await reopened.initialize()
    assert.equal(reopened.rows('SELECT * FROM profiles').length, 2); assert.equal(reopened.rows('SELECT * FROM reports').length, 0)
    await reopened.close()
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('batch uploads parse concurrently with a bounded worker pool', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-concurrency-test-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  let active = 0; let maximumActive = 0; let started = 0
  const backend = new BackendManager(folder, {
    parseConcurrency: 2,
    parser: async () => {
      started++; active++; maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 80))
      active--
      return { page_count: 1, exam_date: '2025-06-01', year: 2025, institution: null, template_type: 'unknown', measurements: [], findings: [], used_ocr: false }
    },
  })
  const server = createServer((req, res) => {
    void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) })
  })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${origin}/profiles`)).json())[0]
    const uploads = await Promise.all(['2025-06-01', '2025-06-02', '2025-06-03'].map(async (date, index) => {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(syntheticPdf(date))], { type: 'application/pdf' }), `batch-${index + 1}.pdf`)
      form.append('profile_id', profile.id)
      const response = await fetch(`${origin}/reports`, { method: 'POST', body: form })
      assert.equal(response.status, 201, await response.clone().text())
      return response.json()
    }))
    for (let attempt = 0; attempt < 100; attempt++) {
      const jobs = await Promise.all(uploads.map(({ job }) => fetch(`${origin}/parse-jobs/${job.id}`).then((response) => response.json())))
      if (jobs.every((job) => ['completed', 'partial', 'failed'].includes(job.status))) break
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.notEqual(attempt, 99, 'batch parse jobs did not settle')
    }
    assert.equal(started, 3)
    assert.equal(maximumActive, 2)
    assert.equal((await (await fetch(`${origin}/reports?profile_id=${profile.id}`)).json()).length, 3)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('AI settings keep secrets outside the database and insights retain verified evidence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-ai-test-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  let tested = false; let generatedPrompt = ''
  const runner: AiModelRunner = {
    async test(settings: AiSettings, key: string) { assert.equal(settings.model, 'test-model'); assert.equal(key, 'private-test-key'); tested = true },
    async generate(_settings: AiSettings, key: string, prompt: string): Promise<InsightOutput> {
      assert.equal(key, 'private-test-key'); generatedPrompt = prompt
      return { summary: '需要关注指标变化。', highlights: [{ title: '指标偏高', explanation: '该指标高于报告参考范围。', level: 'attention', evidence_ids: ['E001', 'invented'] }], limitations: ['仅有一年数据。'], doctor_questions: ['是否需要复查？'] }
    },
    stream(_settings: AiSettings, key: string, messages) {
      assert.equal(key, 'private-test-key'); assert.match(JSON.stringify(messages.at(-1)?.content), /附加血压数据/)
      return createUIMessageStream({ execute: ({ writer }) => {
        writer.write({ type: 'reasoning-start', id: 'reasoning-1' })
        writer.write({ type: 'reasoning-delta', id: 'reasoning-1', delta: '核对证据' })
        writer.write({ type: 'reasoning-end', id: 'reasoning-1' })
        writer.write({ type: 'text-start', id: 'text-1' })
        writer.write({ type: 'text-delta', id: 'text-1', delta: '血糖记录需要关注。[E001]' })
        writer.write({ type: 'text-end', id: 'text-1' })
        writer.write({ type: 'finish', finishReason: 'length' })
      } })
    },
  }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, aiRunner: runner })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const timestamp = new Date().toISOString()
    backend.database.run(`INSERT INTO reports (id,owner_id,profile_id,filename,stored_path,sha256,size_bytes,year,template_type,parse_status,parser_version,created_at,updated_at)
      VALUES ('ai-report','local-owner',:profile,'private-name.pdf',:path,:sha,10,2025,'test','completed','test',:time,:time)`,
    { profile: profile.id, path: join(folder, 'ai.pdf'), sha: 'c'.repeat(64), time: timestamp })
    backend.database.run(`INSERT INTO measurements (id,owner_id,report_id,canonical_id,raw_name,value_numeric,unit,ref_high,ref_text,status,category,organ,confidence,page,raw_text)
      VALUES ('ai-measurement','local-owner','ai-report','glucose','空腹血糖',7.1,'mmol/L',6.1,'3.9-6.1','abnormal','血糖','pancreas',0.98,3,'raw')`)
    await writeFile(join(folder, 'reports-ts', `${'c'.repeat(64)}.pdf`), syntheticPdf())
    await backend.database.persist()
    const providers = await (await fetch(`${api}/ai/providers`)).json(); assert.ok(providers.some((item: { id: string }) => item.id === 'deepseek'))
    const saved = await fetch(`${api}/ai/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', model: 'test-model', api_key: 'private-test-key' }) })
    assert.equal(saved.status, 200, await saved.clone().text()); assert.equal((await saved.json()).has_api_key, true)
    assert.equal((await fetch(`${api}/ai/test`, { method: 'POST' })).status, 200); assert.equal(tested, true)
    const response = await fetch(`${api}/ai/insights`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id, dimension: 'comprehensive', year_from: 2025, year_to: 2025, conversation: [{ role: 'user', content: '之前关注血糖' }, { role: 'assistant', content: '已记录关注点' }] }) })
    assert.equal(response.status, 201, await response.clone().text())
    const insight = await response.json(); assert.deepEqual(insight.content.highlights[0].evidence_ids, ['E001']); assert.equal(insight.evidence[0].page, 3)
    const chat = await fetch(`${api}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id, messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '请分析：附加血压数据 135/88' }] }] }) })
    assert.equal(chat.status, 200, await chat.clone().text()); assert.match(chat.headers.get('content-type') ?? '', /text\/event-stream/)
    const streamed = await chat.text(); assert.match(streamed, /核对证据/); assert.match(streamed, /血糖记录需要关注/); assert.match(streamed, /"finishReason":"length"/)
    assert.doesNotMatch(generatedPrompt, /private-name|private-test-key/)
    assert.match(generatedPrompt, /之前关注血糖/)
    assert.equal((await (await fetch(`${api}/ai/insights?profile_id=${profile.id}`)).json()).length, 1)
    const databaseBytes = await readFile(join(folder, 'healthpocket-ts.db')); assert.equal(databaseBytes.includes(Buffer.from('private-test-key')), false)
    const exported = unzipSync(new Uint8Array(await (await fetch(`${api}/exports`, { method: 'POST' })).arrayBuffer()))
    assert.equal(Buffer.from(exported['manifest.json']!).includes(Buffer.from('private-test-key')), false)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('AI providers come from the Models.dev catalog, calls stream, and keys never cross providers', async () => {
  const requests: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    requests.push({ path: req.url ?? '', auth: req.headers.authorization, body })
    if (body.model === 'broke') { res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Insufficient Balance"}}'); return }
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(chunk({ role: 'assistant', reasoning_content: '思考' }) + chunk({ content: 'HEALTHPOCKET_OK' }, 'stop') + 'data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const model = (id: string, extra: Partial<Model> = {}): Model => ({ id, name: id, description: '', attachment: false, reasoning: true, tool_call: true,
    release_date: '2026-01-01', last_updated: '2026-01-01', modalities: { input: ['text'], output: ['text'] }, open_weights: true, limit: { context: 128_000, output: 8_192 }, ...extra })
  const provider = (id: string, npm: string, api: string | undefined, models: Model[]): Provider => ({ id, name: id, npm, api, env: [], doc: '', models: Object.fromEntries(models.map((item) => [item.id, item])) })
  const fixture: ProviderMap = {
    deepseek: provider('deepseek', '@ai-sdk/openai-compatible', 'https://api.deepseek.com', [model('deepseek-v4-flash')]),
    'siliconflow-cn': provider('siliconflow-cn', '@ai-sdk/openai-compatible', `http://127.0.0.1:${address.port}/v1`, [
      model('Qwen/Qwen3-32B', { release_date: '2026-05-01' }), model('no-tools', { tool_call: false }), model('broke'),
      model('retired', { status: 'deprecated' }), model('painter', { modalities: { input: ['text'], output: ['image'] } }),
    ]),
    'workers-ai': provider('workers-ai', '@ai-sdk/openai-compatible', 'https://api.example.com/accounts/${ACCOUNT_ID}/v1', [model('m')]),
    azure: provider('azure', '@ai-sdk/azure', undefined, [model('m')]),
    'zz-extra': provider('zz-extra', '@ai-sdk/openai-compatible', 'https://api.example.com/v1', [model('m')]),
  }
  const catalog = new AiCatalog(async () => fixture)
  const secrets = new Map<string, string>([['heathpocket-ai-api-key', 'sk-legacy'], ['healthpocket-ai-api-key-siliconflow', 'sk-silicon']])
  // A row saved before the switch to Models.dev ids.
  let row: Record<string, unknown> | null = { provider: 'siliconflow', name: '硅基流动', base_url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-32B', enabled: 1, updated_at: 'then' }
  const db = { one: () => row, run: (_sql: string, params: Record<string, unknown>) => { row = { ...params, updated_at: params.now } }, persist: async () => {} } as unknown as LocalDatabase
  const service = new AiService(db, { get: (id) => secrets.get(id) ?? null, set: (id, value) => { secrets.set(id, value) } }, undefined, catalog)
  try {
    assert.deepEqual((await service.providers()).map((item) => item.id), ['deepseek', 'siliconflow-cn', 'ollama', 'custom', 'zz-extra'])
    assert.deepEqual((await service.models({ provider: 'siliconflow-cn' })).models, ['Qwen/Qwen3-32B', 'broke', 'no-tools'])

    const settings = service.settings()
    assert.equal(settings.provider, 'siliconflow-cn'); assert.equal(settings.has_api_key, true)
    assert.equal(secrets.get('healthpocket-ai-api-key-siliconflow-cn'), 'sk-silicon'); assert.equal(secrets.get('healthpocket-ai-api-key-siliconflow'), '')
    assert.equal(secrets.get('heathpocket-ai-api-key'), '', 'the pre-0.2.0 key is retired, not offered to other providers')
    await assert.rejects(() => service.saveSettings({ provider: 'deepseek', model: 'deepseek-v4-flash' }), /需要 API Key/)
    await assert.rejects(() => service.saveSettings({ provider: 'custom', model: 'm' }), /服务地址/)
    await assert.rejects(() => service.saveSettings({ provider: 'workers-ai', model: 'm' }), /有效的模型供应商/)

    await service.test()
    assert.equal(requests.at(-1)?.path, '/v1/chat/completions'); assert.equal(requests.at(-1)?.auth, 'Bearer sk-silicon'); assert.equal(requests.at(-1)?.body.stream, true)

    const runner = new OpenSourceAiRunner(catalog)
    const tools: ToolSet = { lookup: tool({ description: 'lookup', inputSchema: z.object({}), execute: async () => ({}) }) }
    const ask = async (name: string) => { for await (const _chunk of await runner.stream({ ...settings, model: name }, 'sk-silicon', [{ role: 'user', content: '你好' }], tools)) { /* drain */ } return requests.at(-1)!.body }
    assert.ok((await ask('Qwen/Qwen3-32B')).tools, 'tools are offered to a model that can call them')
    assert.equal((await ask('no-tools')).tools, undefined, 'a model without tool calling still answers')

    const failure = await runner.test({ ...settings, model: 'broke' }, 'sk-silicon').then(() => null, (error: unknown) => error)
    assert.equal(describeModelError(failure), '模型服务账户余额不足，请充值后重试')
  } finally {
    server.closeAllConnections(); server.close()
  }
})

test('daily advice reads Garmin only, the overview reads reports only, and the AI 洞察 advice joins both', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-ai-scope-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const calls: Array<{ system: string; data: Record<string, unknown> }> = []
  const runner: AiModelRunner = {
    async test() {},
    async generate(): Promise<InsightOutput> {
      return { summary: '血脂需要关注。', highlights: [{ title: '总胆固醇偏高', explanation: '高于参考范围。', level: 'attention', evidence_ids: ['E001'] }], limitations: [], doctor_questions: [] }
    },
    async advise(_settings, _key, prompt, system) {
      calls.push({ system, data: (JSON.parse(prompt) as { data: Record<string, unknown> }).data })
      return { summary: /体检报告和 Garmin/.test(system) ? '综合建议' : '日常建议', recommendations: [{ title: '固定作息', category: 'sleep', priority: 'high', why: '睡眠偏短。', actions: ['每天 7:00 起床'] }], cautions: [] }
    },
  }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, aiRunner: runner })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() - offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const timestamp = new Date().toISOString()
    backend.database.run(`INSERT INTO reports (id,owner_id,profile_id,filename,stored_path,sha256,size_bytes,year,template_type,parse_status,parser_version,created_at,updated_at)
      VALUES ('scope-report','local-owner',:profile,'scope.pdf',:path,:sha,10,2025,'test','completed','test',:time,:time)`,
    { profile: profile.id, path: join(folder, 'scope.pdf'), sha: 'd'.repeat(64), time: timestamp })
    backend.database.run(`INSERT INTO measurements (id,owner_id,report_id,canonical_id,raw_name,value_numeric,unit,ref_high,ref_text,status,category,organ,confidence,page,raw_text)
      VALUES ('scope-measurement','local-owner','scope-report','total_cholesterol','总胆固醇',6.8,'mmol/L',5.2,'<5.2','abnormal','血脂','heart',0.98,2,'raw')`)
    for (let offset = 0; offset < 10; offset++) {
      backend.database.run(`INSERT INTO garmin_daily (profile_id,date,steps,sleep_seconds,sleep_score,hrv_last_night,resting_hr,intensity_minutes,raw_json,fetched_at) VALUES (:p,:d,7000,19800,60,45,58,20,'{}','now')`, { p: profile.id, d: day(offset) })
    }
    // Daily advice saved before the split also drew on the reports; it must not resurface.
    backend.database.run(`INSERT INTO ai_insights (id,owner_id,profile_id,dimension,model,summary,content_json,evidence_json,data_fingerprint,created_at)
      VALUES ('old-daily','local-owner',:p,'daily','m','旧建议','{}','{"range":null}','x',:t)`, { p: profile.id, t: timestamp })
    assert.equal((await fetch(`${api}/ai/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', model: 'm', api_key: 'k' }) })).status, 200)

    const range = `from=${day(9)}&to=${day(0)}`
    const daily = await (await fetch(`${api}/daily/insights?profile_id=${profile.id}&${range}`)).json()
    assert.ok(daily.insights.some((item: { id: string }) => item.id === 'sleep-duration'))
    assert.ok(daily.insights.every((item: { category: string }) => item.category !== 'report'), 'the daily page reads Garmin only')
    assert.equal('latest_report' in daily.context, false); assert.equal(daily.advice, null)

    assert.equal((await post(`${api}/daily/advice`, { profile_id: profile.id, from: day(9), to: day(0) })).status, 200)
    assert.match(calls[0]!.system, /只根据 Garmin/); assert.doesNotMatch(JSON.stringify(calls[0]!.data), /胆固醇/)

    assert.equal(await (await fetch(`${api}/ai/advice?profile_id=${profile.id}`)).json(), null)
    assert.equal((await post(`${api}/ai/advice`, { profile_id: profile.id })).status, 200)
    assert.match(calls[1]!.system, /体检报告和 Garmin/)
    assert.match(JSON.stringify(calls[1]!.data.reports), /总胆固醇/); assert.ok(calls[1]!.data.garmin, 'synced Garmin days join the reports')
    assert.equal((await (await fetch(`${api}/ai/advice?profile_id=${profile.id}`)).json()).content.summary, '综合建议')
    assert.equal((await (await fetch(`${api}/daily/insights?profile_id=${profile.id}&${range}`)).json()).advice.content.summary, '日常建议')

    assert.equal((await post(`${api}/ai/insights`, { profile_id: profile.id, dimension: 'comprehensive' })).status, 201)
    const listed = await (await fetch(`${api}/ai/insights?profile_id=${profile.id}`)).json()
    assert.deepEqual(listed.map((item: { dimension: string; stale: boolean }) => [item.dimension, item.stale]), [['comprehensive', false]], 'advice records stay out of the report list')
    backend.database.run(`UPDATE reports SET updated_at=:t WHERE id='scope-report'`, { t: new Date(Date.now() + 60_000).toISOString() })
    assert.equal((await (await fetch(`${api}/ai/insights?profile_id=${profile.id}`)).json())[0].stale, true)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('AI chat sees a Garmin overview for the page range and can query Garmin data through profile-bound tools', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-ai-garmin-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  let captured: { messages: string; tools?: ToolSet } | null = null
  const runner: AiModelRunner = {
    async test() {}, async generate(): Promise<InsightOutput> { throw new Error('not used') },
    stream(_settings, _key, messages, tools) {
      captured = { messages: JSON.stringify(messages.at(-1)?.content), tools }
      return createUIMessageStream({ execute: ({ writer }) => { writer.write({ type: 'text-start', id: 't' }); writer.write({ type: 'text-delta', id: 't', delta: '好的' }); writer.write({ type: 'text-end', id: 't' }) } })
    },
  }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, aiRunner: runner })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const other = await (await fetch(`${api}/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '家人', relationship: 'parent' }) })).json()
    const insertDay = (profileId: string, date: string, sleep: number) => backend.database.run(`INSERT INTO garmin_daily (profile_id,date,steps,sleep_seconds,sleep_score,hrv_last_night,resting_hr,raw_json,fetched_at) VALUES (:p,:d,8000,27000,:s,50,55,'{}','now')`, { p: profileId, d: date, s: sleep })
    for (let day = 1; day <= 28; day++) insertDay(profile.id, `2026-0${day <= 28 ? '8' : '9'}-${String(day).padStart(2, '0')}`, 70 + (day % 10))
    for (let day = 1; day <= 30; day++) insertDay(profile.id, `2026-06-${String(day).padStart(2, '0')}`, 60)
    insertDay(other.id, '2026-08-10', 11)
    backend.database.run(`INSERT INTO garmin_activities (profile_id,activity_id,date,type,name,duration_seconds,distance_m,raw_json,fetched_at) VALUES (:p,'a1','2026-08-05','running','晨跑',1800,5000,'{}','now')`, { p: profile.id })
    backend.database.run(`INSERT INTO garmin_activities (profile_id,activity_id,date,type,name,duration_seconds,raw_json,fetched_at) VALUES (:p,'a2','2026-08-06','cycling','家人骑行',3600,'{}','now')`, { p: other.id })
    assert.equal((await fetch(`${api}/ai/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', model: 'm', api_key: 'k' }) })).status, 200)

    const chat = await fetch(`${api}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id, garmin_range: { from: '2026-08-01', to: '2026-08-28' }, messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '这段时间睡眠怎么样？' }] }] }) })
    assert.equal(chat.status, 200, await chat.clone().text()); await chat.text()
    assert.ok(captured, 'the runner received the question')
    const { messages, tools } = captured as { messages: string; tools?: ToolSet }
    assert.match(messages, /garmin-overview/); assert.match(messages, /page_range/); assert.match(messages, /2026-08-28/)
    assert.doesNotMatch(messages, /家人骑行/)
    assert.deepEqual(Object.keys(tools ?? {}).sort(), ['garmin_activities', 'garmin_daily_metrics'])
    const run = (name: string, input: unknown) => (tools![name]!.execute as (input: unknown, options: unknown) => Promise<Record<string, unknown>>)(input, { toolCallId: 'x', messages: [] })
    const august = await run('garmin_daily_metrics', { from: '2026-08-01', to: '2026-08-31', metrics: ['sleep_score', 'sleep_hours'] })
    assert.equal(august.granularity, 'day'); assert.equal((august.points as unknown[]).length, 28)
    assert.deepEqual((august.points as Array<Record<string, unknown>>)[0], { date: '2026-08-01', sleep_score: 71, sleep_hours: 7.5 })
    const monthly = await run('garmin_daily_metrics', { from: '2025-09-01', to: '2026-08-31', metrics: ['sleep_score'] })
    assert.equal(monthly.granularity, 'week', 'a year defaults to weekly points')
    const byMonth = await run('garmin_daily_metrics', { from: '2025-09-01', to: '2026-08-31', metrics: ['sleep_score'], granularity: 'month' })
    assert.deepEqual((byMonth.points as Array<Record<string, unknown>>).map((p) => [p.date, p.sleep_score]), [['2026-06', 60], ['2026-08', 74.5]])
    const activities = await run('garmin_activities', { from: '2026-08-01', to: '2026-08-31' })
    assert.equal((activities.summary as { count: number }).count, 1, 'another profile\'s workouts are out of reach')
    assert.equal((activities.items as Array<{ name: string }>)[0]!.name, '晨跑')

    captured = null
    const reportsOnly = await fetch(`${api}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: (await (await fetch(`${api}/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '空档案', relationship: 'other' }) })).json()).id, messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: '你好' }] }] }) })
    await reportsOnly.text()
    assert.equal((captured as { tools?: ToolSet } | null)?.tools, undefined, 'no Garmin tools without Garmin data')
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('a Garmin login does not queue behind slow unrelated work', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-lane-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  // Stands in for the minutes-long single LLM call an insight generation makes.
  let insightRunning = false
  let releaseInsight: () => void = () => undefined
  let announceInsight: () => void = () => undefined
  const insightStarted = new Promise<void>((resolve) => { announceInsight = resolve })
  const runner: AiModelRunner = {
    async test() { /* not exercised here */ },
    async generate(): Promise<InsightOutput> {
      insightRunning = true; announceInsight()
      await new Promise<void>((done) => { releaseInsight = () => { insightRunning = false; done() } })
      return { summary: '摘要', highlights: [], limitations: [], doctor_questions: [] }
    },
    stream() { throw new Error('stream is not exercised in this test') },
  }
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const client = { getTokens: () => tokens, getDisplayName: () => 'Runner' } as GarminClientLike
  const factory: GarminClientFactory = {
    async start() { return { status: 'authenticated', tokens } },
    async fromTokens() { return client },
  }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, aiRunner: runner, garminClientFactory: factory })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const timestamp = new Date().toISOString()
    backend.database.run(`INSERT INTO reports (id,owner_id,profile_id,filename,stored_path,sha256,size_bytes,year,template_type,parse_status,parser_version,created_at,updated_at)
      VALUES ('lane-report','local-owner',:profile,'private-name.pdf',:path,:sha,10,2025,'test','completed','test',:time,:time)`,
    { profile: profile.id, path: join(folder, 'lane.pdf'), sha: 'd'.repeat(64), time: timestamp })
    backend.database.run(`INSERT INTO measurements (id,owner_id,report_id,canonical_id,raw_name,value_numeric,unit,ref_high,ref_text,status,category,organ,confidence,page,raw_text)
      VALUES ('lane-measurement','local-owner','lane-report','glucose','空腹血糖',7.1,'mmol/L',6.1,'3.9-6.1','abnormal','血糖','pancreas',0.98,3,'raw')`)
    await backend.database.persist()
    const savedSettings = await fetch(`${api}/ai/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', model: 'test-model', api_key: 'private-test-key' }) })
    assert.equal(savedSettings.status, 200, await savedSettings.clone().text())

    // Occupy the shared mutation lane with work that will not finish until this
    // test lets it - the situation that used to make a login report a timeout
    // without ever reaching Garmin.
    const insight = fetch(`${api}/ai/insights`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id, dimension: 'comprehensive', year_from: 2025, year_to: 2025 }) })
    insight.catch(() => undefined)
    await insightStarted
    assert.equal(insightRunning, true)

    let loginBudget: NodeJS.Timeout | undefined
    const guard = new Promise<never>((_, reject) => {
      loginBudget = setTimeout(() => reject(new Error('the Garmin login waited behind unrelated work')), 5_000)
    })
    const loginResponse = await (async () => {
      try {
        return await Promise.race([fetch(`${api}/garmin/settings`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'runner@example.com', password: 'private-garmin-password', region: 'cn', profile_id: profile.id }),
        }), guard])
      } finally { if (loginBudget) clearTimeout(loginBudget) }
    })()
    assert.equal(loginResponse.status, 200, await loginResponse.clone().text())
    assert.equal((await loginResponse.json()).authenticated, true)
    assert.equal(insightRunning, true, 'the insight generation should still be in flight')

    // The queue is reported, so a wedged lane is visible instead of guessed at.
    const health = await (await fetch(`${api}/health`)).json()
    assert.equal(health.queue.active?.label, 'POST /ai/insights')
    assert.equal(typeof health.queue.garmin_active, 'number')

    releaseInsight()
    assert.equal((await insight).status, 201)
  } finally {
    releaseInsight()
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('Garmin credentials stay in secret storage while health and activity data are persisted', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-test-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const client: GarminClientLike = {
    getTokens: () => tokens, getDisplayName: () => 'Runner',
    async getDailySummary(date) { return { calendarDate: date, totalSteps: 8123, totalDistanceMeters: 6120, activeKilocalories: 420, bmrKilocalories: 1500, restingHeartRate: 52, privacyProtected: false } },
    async getSleepData(date) { return { dailySleepDTO: { id: 1, userProfilePK: 2, calendarDate: date, sleepTimeSeconds: 27000, deepSleepSeconds: 5400, lightSleepSeconds: 14400, remSleepSeconds: 5400, awakeSleepSeconds: 1800, sleepScores: { overall: { value: 86 } } } } },
    async getHrvSummary(date) { return { hrvSummary: { calendarDate: date, lastNightAvg: 48, weeklyAvg: 46, lastNight5MinHigh: 72, status: 'BALANCED' } } },
    async getActivities(start) { return start ? [] : [{ activityId: 99, activityName: 'Morning Run', activityType: { typeId: 1, typeKey: 'running' }, startTimeGMT: '2026-09-19T23:00:00', startTimeLocal: '2026-09-20T07:00:00', duration: 3600, distance: 10000, calories: 620 }] },
    async getDailyHeartRate() { return { restingHeartRate: 52, minHeartRate: 45, maxHeartRate: 171 } }, async getDailyStress() { return { avgStressLevel: 22, maxStressLevel: 68 } },
    async getBodyBatteryDaily() { return [] }, async getBodyBatteryEvents() { return {} }, async getTrainingStatus() { return { userId: 1, trainingStatusMessage: 'PRODUCTIVE', fitnessAge: 31 } },
    async getTrainingReadiness(date) { return { calendarDate: date, score: 79 } }, async getVo2Max(first, end) { assert.ok((Date.parse(end) - Date.parse(first)) / 86_400_000 < 28); return [{ calendarDate: end, vo2MaxPreciseValue: 51, fitnessAge: 31 }] },
    async getRacePredictions() { return {} }, async getHillScore() { return [] }, async getEnduranceScore() { return [] },
    async getDailyRespiration() { return { startTimeGMT: 0, endTimeGMT: 1, startTimeLocal: 0, endTimeLocal: 1, avgWakingRespirationValue: 14, highestRespirationValue: 18, lowestRespirationValue: 10, avgSleepRespirationValue: 12 } },
    async getDailySpO2(date) { return { calendarDate: date, averageSpO2: 97, lowestSpO2: 94 } }, async getDailyIntensityMinutes(date) { return [{ calendarDate: date, weeklyGoal: 150, moderateIntensityMinutes: 20, vigorousIntensityMinutes: 10 }] },
    async getDailySteps(first, last) { assert.ok((Date.parse(last) - Date.parse(first)) / 86_400_000 < 28); return [] }, async getFloors() { return { floorsAscended: 8 } },
  }
  let profileLookups = 0
  const factory: GarminClientFactory = {
    async start(email, password, domain) { assert.equal(email, 'runner@example.com'); assert.equal(password, 'private-garmin-password'); assert.equal(domain, 'garmin.cn'); return { status: 'authenticated', tokens } },
    async fromTokens(saved, domain) { profileLookups++; assert.equal(saved.oauth1.oauth_token, 'oauth-one'); assert.equal(domain, 'garmin.cn'); return client },
  }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, garminClientFactory: factory })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const login = await fetch(`${api}/garmin/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'runner@example.com', password: 'private-garmin-password', region: 'cn', profile_id: profile.id }) })
    assert.equal(login.status, 200, await login.clone().text()); assert.equal((await login.json()).authenticated, true)
    assert.equal(profileLookups, 0, 'login must save tokens without profile or data requests')
    const sync = await fetch(`${api}/garmin/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id }) })
    assert.equal(sync.status, 200, await sync.clone().text())
    assert.equal(profileLookups, 1, 'only manual sync constructs a data client')
    const dashboard = await sync.json(); assert.equal(dashboard.latest.hrv_last_night, 48); assert.equal(dashboard.latest.sleep_score, 86)
    assert.equal(dashboard.latest.fitness_age, 31); assert.equal(dashboard.activity_summary.count, 1); assert.equal(dashboard.activity_summary.duration_seconds, 3600)
    backend.database.run('UPDATE garmin_daily SET hrv_last_night=NULL,hrv_weekly_avg=NULL WHERE profile_id=:profile AND date=:date', { profile: profile.id, date: dashboard.latest.date })
    const recovered = await (await fetch(`${api}/garmin/dashboard?profile_id=${profile.id}`)).json()
    assert.equal(recovered.latest.hrv_last_night, 48, 'read an older stored Garmin HRV wrapper without another download')
    const julySync = await fetch(`${api}/garmin/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id, month: '2026-07' }) })
    assert.equal(julySync.status, 200, await julySync.clone().text())
    const julyDashboard = await julySync.json(); assert.equal(julyDashboard.synced_days, 31)
    assert.equal(julyDashboard.trends.filter((day: { date: string }) => day.date.startsWith('2026-07')).length, 31)
    assert.equal(julyDashboard.trends.find((day: { date: string }) => day.date === '2026-07-15')?.hrv_last_night, 48)
    assert.equal(julyDashboard.trends.find((day: { date: string }) => day.date === '2026-07-15')?.sleep_score, 86)
    const databaseBytes = await readFile(join(folder, 'healthpocket-ts.db'))
    assert.equal(databaseBytes.includes(Buffer.from('private-garmin-password')), false); assert.equal(databaseBytes.includes(Buffer.from('oauth-two')), false)
    const exported = unzipSync(new Uint8Array(await (await fetch(`${api}/exports`, { method: 'POST' })).arrayBuffer()))
    const manifest = JSON.parse(Buffer.from(exported['manifest.json']!).toString())
    assert.equal(manifest.garmin.daily.length, 61); assert.equal(manifest.garmin.activities[0].name, 'Morning Run')
    assert.equal(Buffer.from(exported['manifest.json']!).includes(Buffer.from('private-garmin-password')), false)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('a Garmin date-range backfill runs in the background, resumes where it failed and stores no time series', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-range-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const day = (offset: number) => { const value = new Date(); value.setHours(12, 0, 0, 0); value.setDate(value.getDate() + offset); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` }
  let failOn: string | null = day(-20)
  const fetched: string[] = []
  const client = {
    getTokens: () => tokens, getDisplayName: () => 'Runner',
    async getDailySummary(date: string) {
      if (date === failOn) throw Object.assign(new Error('Garmin 500'), { statusCode: 500 })
      fetched.push(date); return { calendarDate: date, totalSteps: 8000 }
    },
    async getSleepData(date: string) { return { dailySleepDTO: { calendarDate: date, sleepTimeSeconds: 27000, sleepScores: { overall: { value: 80 } } }, sleepMovement: [{ activityLevel: 1 }], wellnessEpochSPO2DataDTOList: [{ spo2Reading: 96 }] } },
    async getHrvSummary(date: string) { return { hrvSummary: { calendarDate: date, lastNightAvg: 50, weeklyAvg: 47 } } },
    async getActivities() { return [] },
    async getDailyHeartRate() { return { restingHeartRate: 50, heartRateValues: [[1, 60]] } }, async getDailyStress() { return { avgStressLevel: 20, stressValuesArray: [[1, 20]] } },
    async getBodyBatteryDaily() { return [] }, async getBodyBatteryEvents() { return {} }, async getTrainingStatus() { return {} },
    async getTrainingReadiness() { return {} }, async getVo2Max(first: string, end: string) { assert.ok((Date.parse(end) - Date.parse(first)) / 86_400_000 < 28); return [] },
    async getRacePredictions() { return {} }, async getHillScore() { return [] }, async getEnduranceScore() { return [] },
    async getDailyRespiration() { return {} }, async getDailySpO2() { return {} }, async getDailyIntensityMinutes() { return [] },
    async getDailySteps(first: string, last: string) { assert.ok((Date.parse(last) - Date.parse(first)) / 86_400_000 < 28); return [] }, async getFloors() { return {} },
  } as unknown as GarminClientLike
  const factory: GarminClientFactory = { async start() { return { status: 'authenticated', tokens } }, async fromTokens() { return client } }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, garminClientFactory: factory })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const post = (path: string, body: unknown, method = 'POST') => fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post('/garmin/settings', { email: 'runner@example.com', password: 'pw', region: 'cn', profile_id: profile.id }, 'PUT')).status, 200)
    const settle = async () => {
      for (let i = 0; i < 200; i++) {
        const settings = await (await fetch(`${api}/garmin/settings`)).json()
        if (!settings.syncing) return settings
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('background sync never finished')
    }
    const stored = () => backend.database.rows<{ date: string }>('SELECT date FROM garmin_daily WHERE profile_id=:profile ORDER BY date', { profile: profile.id }).map((row) => row.date)

    const range = { profile_id: profile.id, from: day(-40), to: day(0), background: true }
    const started = await post('/garmin/sync', range)
    assert.equal(started.status, 202, await started.clone().text())
    assert.equal((await started.json()).syncing, true)
    assert.equal((await post('/garmin/sync', range)).status, 409, 'a second sync waits for the first')
    assert.equal((await fetch(`${api}/garmin/settings`, { method: 'DELETE' })).status, 409, 'cannot disconnect under a running sync')
    const failed = await settle()
    const firstRun = stored()
    assert.ok(firstRun.length > 0 && firstRun.length < 41, 'windows before the failure are kept')
    assert.match(failed.last_sync_error, new RegExp(`已保存 ${firstRun.length}/41 天`))
    assert.equal(failed.last_sync_result, null)

    failOn = null; fetched.length = 0
    assert.equal((await post('/garmin/sync', range)).status, 202)
    const finished = await settle()
    assert.equal(finished.last_sync_error, null)
    assert.equal(stored().length, 41)
    assert.deepEqual(fetched.filter((date) => firstRun.includes(date) && date < day(-2)), [], 'stored days are not fetched again')
    assert.equal(finished.last_sync_result.synced_days, fetched.length)

    const raw = backend.database.one<{ raw_json: string }>('SELECT raw_json FROM garmin_daily WHERE profile_id=:profile AND date=:date', { profile: profile.id, date: day(0) })!.raw_json
    assert.ok(raw.includes('dailySleepDTO') && raw.includes('restingHeartRate'))
    for (const series of ['sleepMovement', 'wellnessEpochSPO2DataDTOList', 'heartRateValues', 'stressValuesArray']) assert.equal(raw.includes(series), false, `${series} is not stored`)

    backend.database.run('UPDATE garmin_daily SET raw_json=:raw WHERE profile_id=:profile AND date=:date', { profile: profile.id, date: day(-30), raw: JSON.stringify({ sleep: { dailySleepDTO: { sleepTimeSeconds: 1 }, sleepMovement: [1, 2, 3] }, hrv: null }) })
    const api_ = (backend as unknown as { api: { slimGarminSnapshots(): Promise<number> } }).api
    assert.equal(await api_.slimGarminSnapshots(), 1, 'snapshots saved by older builds are slimmed once')
    assert.equal(await api_.slimGarminSnapshots(), 0)

    const windowed = await (await fetch(`${api}/garmin/dashboard?profile_id=${profile.id}&from=${day(-9)}&to=${day(0)}`)).json()
    assert.equal(windowed.trends.length, 10)
    assert.equal(windowed.totals.days, 41)
    assert.equal(windowed.latest.date, day(0))
    assert.equal('raw_json' in windowed.trends[0], false)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('Garmin sync uses the saved token and does not silently start another MFA login when profile loading fails', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-sync-token-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const values = new Map<string, string>()
  let starts = 0
  const tokens: GarminTokens = { oauth1: { oauth_token: 'saved-one', oauth_token_secret: 'secret' }, oauth2: {
    scope: '', jti: '', token_type: 'Bearer', access_token: 'saved-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200,
    refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  } }
  const factory: GarminClientFactory = {
    async start() { starts++; return { status: 'authenticated', tokens } },
    async fromTokens(saved) {
      assert.equal(saved.oauth2.access_token, 'saved-two')
      throw new Error('账号资料请求超时')
    },
  }
  const backend = new BackendManager(folder, { secretStore: { get: id => values.get(id) ?? null, set: (id, value) => { values.set(id, value) } }, garminClientFactory: factory })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const login = await fetch(`${api}/garmin/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'runner@example.com', password: 'private-password', region: 'global', profile_id: profile.id }) })
    assert.equal(login.status, 200)
    const sync = await fetch(`${api}/garmin/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id }) })
    assert.equal(sync.status, 502)
    assert.match((await sync.json()).detail, /账号资料请求超时/)
    assert.equal(starts, 1, 'the sync must not start a new login')
    assert.equal((await (await fetch(`${api}/garmin/settings`)).json()).authenticated, true)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('only a login Garmin actually refused is reported as expired', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-expired-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const values = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'saved-one', oauth_token_secret: 'secret' }, oauth2: {
    scope: '', jti: '', token_type: 'Bearer', access_token: 'saved-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200,
    refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  } }
  let failure: Error = new Error('unset')
  const factory: GarminClientFactory = {
    async start() { return { status: 'authenticated', tokens } },
    async fromTokens() { throw failure },
  }
  const backend = new BackendManager(folder, { secretStore: { get: id => values.get(id) ?? null, set: (id, value) => { values.set(id, value) } }, garminClientFactory: factory })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const login = await fetch(`${api}/garmin/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'runner@example.com', password: 'private-password', region: 'global', profile_id: profile.id }) })
    assert.equal(login.status, 200)
    const syncDetail = async (error: Error) => {
      failure = error
      const sync = await fetch(`${api}/garmin/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id }) })
      return String((await sync.json()).detail)
    }
    // Refused by Garmin: the user really has to sign in again.
    assert.match(await syncDetail(new GarminAuthError('Failed to exchange for OAuth2 (401): denied')), /登录已失效/)
    assert.match(await syncDetail(new GarminAuthError('Authentication failed (401)')), /登录已失效/)
    // Merely failed: a server error, a consumer download, or any error whose text
    // happens to mention a token must not send the user back to the login form.
    assert.doesNotMatch(await syncDetail(new GarminAuthError('Failed to exchange for OAuth2 (502): bad gateway')), /登录已失效/)
    assert.doesNotMatch(await syncDetail(new GarminAuthError('Failed to fetch OAuth consumer credentials')), /登录已失效/)
    assert.doesNotMatch(await syncDetail(new Error('token endpoint socket hang up')), /登录已失效/)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('macOS Garmin proxy parser accepts enabled HTTPS proxies only', () => {
  assert.equal(macOsGarminProxy('  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 6696\n'), 'http://127.0.0.1:6696')
  assert.equal(macOsGarminProxy('  HTTPSEnable : 0\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 6696\n'), null)
})

test('token, origin and host checks prevent cross-site access to health data', () => {
  const request = (headers: Record<string, string>, url = '/heathpocket/api/reports?token=secret') => ({ headers, url }) as IncomingMessage
  assert.equal(authorizedRequest(request({ host: '127.0.0.1:1234' }), 'http://127.0.0.1:1234', 'secret'), true)
  assert.equal(authorizedRequest(request({ host: '127.0.0.1:1234', origin: 'https://example.com' }), 'http://127.0.0.1:1234', 'secret'), false)
  assert.equal(authorizedRequest(request({ host: 'attacker.example:1234' }), 'http://127.0.0.1:1234', 'secret'), false)
  assert.equal(authorizedRequest(request({ host: '127.0.0.1:1234' }, '/heathpocket/api/data'), 'http://127.0.0.1:1234', 'secret'), false)
})

test('legacy database is copied, risk evidence stays year-specific, and original bytes remain unchanged', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-migration-test-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const db = new LocalDatabase(folder)
  try {
    await db.initialize()
    const profile = db.one<{ id: string }>('SELECT id FROM profiles')!.id
    const timestamp = new Date().toISOString()
    for (const [id, year, status] of [['older', 2024, 'abnormal'], ['newer', 2025, 'normal']] as const) {
      db.run(`INSERT INTO reports (id,owner_id,profile_id,filename,stored_path,sha256,size_bytes,year,template_type,parse_status,parser_version,created_at,updated_at)
        VALUES (:id,'local-owner',:profile,'test.pdf',:path,:sha,10,:year,'test','completed','test',:time,:time)`,
      { id, profile, path: join(folder, `${id}.pdf`), sha: (id === 'older' ? 'a' : 'b').repeat(64), year, time: timestamp })
      db.run(`INSERT INTO measurements (id,owner_id,report_id,canonical_id,raw_name,value_numeric,ref_high,status,category,organ,confidence,page,raw_text)
        VALUES (:id,'local-owner',:id,'alt','丙氨酸氨基转移酶',:value,40,:status,'肝胆功能','liver',0.96,1,'test')`, { id, value: status === 'abnormal' ? 50 : 20, status })
      await writeFile(join(folder, `${id}.pdf`), syntheticPdf())
    }
    const agg = new Aggregation(db)
    const timeline = agg.timeline(profile, 'liver')!
    assert.deepEqual(timeline.years.map((year) => [year.year, year.status, year.abnormal_count]), [[2024, 'abnormal', 1], [2025, 'normal', 0]])
    assert.equal(agg.riskDetail(profile, 'hepatobiliary', 2024)?.abnormal_count, 1)
    await db.persist(); await db.close()
    await copyFile(join(folder, 'healthpocket-ts.db'), join(folder, 'healthpocket.db'))
    const original = await readFile(join(folder, 'healthpocket.db'))
    await rm(join(folder, 'healthpocket-ts.db'))
    const migrated = new LocalDatabase(folder); await migrated.initialize()
    assert.equal(migrated.rows('SELECT * FROM reports').length, 2)
    assert.equal(migrated.rows('SELECT * FROM profiles').length, 1)
    assert.deepEqual(await readFile(join(folder, 'healthpocket.db')), original)
    assert.deepEqual(await readFile(join(folder, 'reports-ts', `${'a'.repeat(64)}.pdf`)), syntheticPdf())
    await migrated.close()
  } finally {
    await db.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('Garmin MFA login parks the session, survives a wrong code and finishes with the emailed code', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-mfa-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const client = { getTokens: () => tokens, getDisplayName: () => 'Runner' } as GarminClientLike
  const submitted: string[] = []
  let starts = 0
  const factory: GarminClientFactory = {
    async start() {
      starts++
      return { status: 'mfa', challenge: {
        method: 'email', target: 'te********@example.com', maskedPhone: '*********0000', allowPhone: true,
        async verify(code) {
          submitted.push(code)
          if (code !== '246810') throw new GarminLoginError('credentials', '验证码不正确或已过期，请重新输入')
          return tokens
        },
      } }
    },
    async fromTokens() { return client },
  }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, garminClientFactory: factory })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  const post = (api: string, path: string, body?: unknown) => fetch(`${api}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const login = (api: string, profileId: string) => fetch(`${api}/garmin/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'runner@example.com', password: 'private-garmin-password', region: 'cn', profile_id: profileId }),
  })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]

    const response = await login(api, profile.id)
    assert.equal(response.status, 200, await response.clone().text())
    const parked = await response.json()
    // A parked login is not an authenticated account yet.
    assert.equal(parked.authenticated, false)
    assert.equal(parked.mfa.required, true)
    assert.equal(parked.mfa.target, 'te********@example.com')
    assert.equal(parked.mfa.masked_phone, '*********0000')
    assert.equal(parked.mfa.allow_phone, true)
    assert.equal(parked.mfa.email, 'runner@example.com')

    // A wrong code is reported without throwing the session away.
    const wrong = await post(api, '/garmin/settings/mfa', { code: '111111' })
    assert.equal(wrong.status, 422)
    assert.match((await wrong.json()).detail, /验证码不正确/)
    const stillParked = await (await fetch(`${api}/garmin/settings`)).json()
    assert.equal(stillParked.mfa.required, true)

    // Malformed input is rejected before Garmin is bothered.
    const malformed = await post(api, '/garmin/settings/mfa', { code: '12' })
    assert.equal(malformed.status, 422)
    assert.equal(submitted.length, 1)

    // "Resend" restarts the login and keeps the session parked.
    const resent = await post(api, '/garmin/settings/mfa/resend')
    assert.equal(resent.status, 200, await resent.clone().text())
    assert.equal((await resent.json()).mfa.required, true)
    assert.equal(starts, 2)

    const done = await post(api, '/garmin/settings/mfa', { code: '246810', method: 'email' })
    assert.equal(done.status, 200, await done.clone().text())
    const authenticated = await done.json()
    assert.equal(authenticated.authenticated, true)
    assert.equal(authenticated.display_name, 'Runner')
    assert.equal(authenticated.mfa, null)
    assert.deepEqual(submitted, ['111111', '246810'])

    // Only the OAuth tokens are kept, and only in secret storage: the password
    // is never written anywhere once the login has finished.
    const databaseBytes = await readFile(join(folder, 'healthpocket-ts.db'))
    assert.equal(databaseBytes.includes(Buffer.from('private-garmin-password')), false)
    assert.equal(databaseBytes.includes(Buffer.from('oauth-two')), false)
    assert.equal([...secretValues.values()].some((value) => value.includes('private-garmin-password')), false)
    assert.match(secretValues.get('healthpocket-garmin-tokens') ?? '', /oauth-two/)

    // Cancelling drops the parked session.
    const restart = await login(api, profile.id)
    assert.equal((await restart.json()).mfa.required, true)
    const cancelled = await fetch(`${api}/garmin/settings/mfa`, { method: 'DELETE' })
    assert.equal(cancelled.status, 200)
    assert.equal((await cancelled.json()).mfa, null)
  } finally {
    server.closeAllConnections(); server.close(); backend.dispose(); await backend.database.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('Garmin mobile auth flow sends session cookies, verifies MFA and exchanges the ticket for tokens', async () => {
  const seen: { loginCookie: string; verifyCookie: string; verifyBody: Record<string, unknown>; portal: number; preauthorized: string[]; preauthorizedCookies: string[]; exchangeBodies: string[] } =
    { loginCookie: '', verifyCookie: '', verifyBody: {}, portal: 0, preauthorized: [], preauthorizedCookies: [], exchangeBodies: [] }
  let rejectAudience = true
  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const body = await readBody(req)
    const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (url.pathname === '/mobile/sso/en/sign-in') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['SESSION=abc123; Path=/', 'CF=xyz; Path=/'] })
      res.end('<title>Garmin SSO Portal</title>'); return
    }
    if (url.pathname === '/mobile/api/login') {
      seen.loginCookie = String(req.headers.cookie ?? '')
      const credentials = JSON.parse(body || '{}') as { password?: string }
      assert.equal(url.searchParams.get('clientId'), 'GCM_ANDROID_DARK')
      if (credentials.password === 'wrong-password') return json(200, { responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } })
      if (credentials.password === 'mfa-password') return json(200, {
        responseStatus: { type: 'MFA_REQUIRED', message: '' },
        customerMfaInfo: { email: 'te********@example.com', phoneNumber: '*********0000', mfaLastMethodUsed: 'email', mfaUISetting: { allowPhoneOption: true } },
      })
      return json(200, { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-direct' })
    }
    if (url.pathname === '/mobile/api/mfa/verifyCode') {
      seen.verifyCookie = String(req.headers.cookie ?? '')
      seen.verifyBody = JSON.parse(body || '{}') as Record<string, unknown>
      if (seen.verifyBody.mfaVerificationCode !== '246810') return json(200, { responseStatus: { type: 'INVALID_MFA_CODE' } })
      return json(200, { responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-mfa' })
    }
    // garth's SSO backend pinning: the reply is a 403, but it still hands out
    // the session cookies the ticket redemption is checked against.
    if (url.pathname === '/portal/sso/embed') {
      seen.portal++
      res.writeHead(403, { 'set-cookie': ['CASTGC=castgc-1; Path=/', 'GARMIN-SSO=garmin-sso-1; Path=/'] })
      res.end(''); return
    }
    if (url.pathname === '/oauth-service/oauth/preauthorized') {
      seen.preauthorized.push(String(req.headers.authorization ?? ''))
      seen.preauthorizedCookies.push(String(req.headers.cookie ?? ''))
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('oauth_token=oauth-one&oauth_token_secret=oauth-secret'); return
    }
    if (url.pathname === '/oauth-service/oauth/exchange/user/2.0') {
      seen.exchangeBodies.push(body)
      const audience = new URLSearchParams(body).get('audience')
      if (audience && rejectAudience) return json(400, { error: 'invalid_audience' })
      return json(200, { scope: '', jti: 'jti-1', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh-one', expires_in: 3600, refresh_token_expires_in: 7200 })
    }
    if (url.pathname === '/oauth_consumer.json') return json(200, { consumer_key: 'consumer-key', consumer_secret: 'consumer-secret' })
    json(404, { error: 'not-found', path: url.pathname })
  })().catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const flow = createGarminAuthFlow({ endpoints: { sso: () => base, service: () => base, connectApi: () => base, consumerUrl: `${base}/oauth_consumer.json` } })

    // 1. A definitive bad password is reported as such and never retried elsewhere.
    await assert.rejects(() => flow.start('runner@example.com', 'wrong-password', 'garmin.cn'), (error: unknown) => {
      assert.ok(error instanceof GarminLoginError)
      assert.equal(error.kind, 'credentials')
      assert.match(error.message, /账号或密码不正确/)
      assert.equal(error.fallbackAllowed, false)
      return true
    })

    // 2. MFA: the challenge reports where the code went, cookies travel with the request.
    const started = await flow.start('runner@example.com', 'mfa-password', 'garmin.cn')
    assert.ok(started.status === 'mfa')
    assert.equal(started.challenge.method, 'email')
    assert.equal(started.challenge.target, 'te********@example.com')
    assert.equal(started.challenge.maskedPhone, '*********0000')
    assert.equal(started.challenge.allowPhone, true)
    assert.match(seen.loginCookie, /SESSION=abc123/)
    assert.match(seen.loginCookie, /CF=xyz/)

    // 3. A wrong code keeps the session usable.
    await assert.rejects(() => started.challenge.verify('000000'), /验证码不正确或已过期/)
    assert.equal(seen.verifyBody.mfaMethod, 'email')
    assert.match(seen.verifyCookie, /SESSION=abc123/)

    // 4. The right code yields the same token pair the data path persists.
    const tokens = await started.challenge.verify('246810')
    assert.equal(tokens.oauth1.oauth_token, 'oauth-one')
    assert.equal(tokens.oauth1.oauth_token_secret, 'oauth-secret')
    assert.equal(tokens.oauth2.access_token, 'oauth-two')
    assert.ok(tokens.oauth2.expires_at > Math.floor(Date.now() / 1000))
    assert.equal(tokens.oauth2.refresh_token, 'refresh-one')
    assert.match(seen.preauthorized[0] ?? '', /^OAuth /)
    // The ticket is redeemed by the same SSO session that requested it: the
    // 403 from the backend-pinning call still contributed cookies.
    assert.equal(seen.portal, 1)
    assert.match(seen.preauthorizedCookies[0] ?? '', /CASTGC=castgc-1/)
    assert.match(seen.preauthorizedCookies[0] ?? '', /SESSION=abc123/)
    // The Android integration audience is tried first and dropped when Garmin refuses it.
    assert.equal(seen.exchangeBodies.length, 2)
    assert.equal(new URLSearchParams(seen.exchangeBodies[0]!).get('audience'), 'GARMIN_CONNECT_MOBILE_ANDROID_DI')
    assert.equal(new URLSearchParams(seen.exchangeBodies[1]!).get('audience'), null)

    // 5. Once Garmin accepts the audience, a single exchange is enough.
    rejectAudience = false
    seen.exchangeBodies.length = 0
    const direct = await flow.start('runner@example.com', 'plain-password', 'garmin.cn')
    assert.ok(direct.status === 'authenticated')
    assert.equal(direct.tokens.oauth2.access_token, 'oauth-two')
    assert.equal(seen.exchangeBodies.length, 1)
    assert.equal(new URLSearchParams(seen.exchangeBodies[0]!).get('audience'), 'GARMIN_CONNECT_MOBILE_ANDROID_DI')
    assert.equal(seen.portal, 2)
  } finally {
    server.closeAllConnections(); server.close()
  }
})

/**
 * Answers every hop of a direct Garmin login from memory, so a test can drive the
 * real `createGarminAuthFlow` without a socket. The published consumer URL is
 * delegated to the caller: that is where the "was it fetched at all" question
 * gets answered, and it is the only hop these tests care about.
 */
function stubGarminLogin(
  onConsumer: (attempt: number) => Response,
  seen: { authorizations: string[] },
): { fetch: typeof globalThis.fetch; endpoints: GarminAuthEndpoints; consumerAttempts: () => number } {
  const base = 'https://stub.garmin.test'
  let attempts = 0
  const reply = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  const handler = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const address = String(input)
    if (address === OAUTH_CONSUMER_URL) return onConsumer(++attempts)
    if (address.includes('/mobile/sso/en/sign-in')) return new Response('<title>Garmin SSO</title>', { status: 200 })
    if (address.includes('/mobile/api/login')) return reply({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-direct' })
    if (address.includes('/portal/sso/embed')) return new Response('', { status: 403 })
    if (address.includes('/oauth-service/oauth/preauthorized')) {
      seen.authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))
      return new Response('oauth_token=oauth-one&oauth_token_secret=oauth-secret', { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    if (address.includes('/oauth-service/oauth/exchange/user/2.0')) {
      return reply({ scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600 })
    }
    return new Response('not found', { status: 404 })
  }
  return {
    fetch: handler as unknown as typeof globalThis.fetch,
    endpoints: { sso: () => base, service: () => base, connectApi: () => base, consumerUrl: OAUTH_CONSUMER_URL },
    consumerAttempts: () => attempts,
  }
}

test('a saved Garmin consumer is reused, so a restart never asks S3 again', async () => {
  // Both the shared map and the registered store are module-level -- that is what
  // makes the copy survive a reload -- so start cold or the assertions below could
  // pass on state another test left behind.
  forgetGarminOAuthConsumer()
  const seen = { authorizations: [] as string[] }
  let reads = 0
  const store: GarminConsumerStore = {
    read: () => { reads++; return { consumer_key: 'saved-key', consumer_secret: 'saved-secret' } },
    // A copy that came from disk must not be written back: this is the whole
    // reason the "failing sync after every reload" bug is gone.
    write: () => { throw new Error('the saved consumer must not be rewritten') },
  }
  setGarminConsumerStore(store)
  const stub = stubGarminLogin(() => { throw new Error('the published consumer must not be fetched') }, seen)
  const flow = createGarminAuthFlow({ fetch: stub.fetch, endpoints: stub.endpoints })

  const outcome = await flow.start('runner@example.com', 'private-garmin-password', 'garmin.cn')
  assert.equal(outcome.status, 'authenticated')
  assert.equal(reads, 1, 'the saved copy is what the login used')
  assert.equal(stub.consumerAttempts(), 0, 'nothing was fetched from the network')
  // Not just "no request": the saved pair is the one that signed the ticket
  // redemption, so it is provably the credential in use.
  assert.match(seen.authorizations[0] ?? '', /saved-key/)
})

test('a Garmin consumer fetch that never settles is retried once, then saved', async () => {
  forgetGarminOAuthConsumer()
  const saved: unknown[] = []
  setGarminConsumerStore({ read: () => null, write: (consumer) => { saved.push(consumer) } })
  const stub = stubGarminLogin((attempt) => {
    // Exactly the shape the transport reports when a proxy hands over headers and
    // then stops: an answer that is not an answer, so it is worth asking twice.
    if (attempt === 1) {
      const stalled = new Response('{}', { status: 200 })
      Object.defineProperty(stalled, 'json', { value: async () => {
        throw Object.assign(new Error('获取 Garmin 应用凭据超时（响应头已收到，但 24 秒内没有读完响应内容），请检查网络或代理后重试'), { [REQUEST_TIMEOUT]: true })
      } })
      return stalled
    }
    return new Response(JSON.stringify({ consumer_key: 'consumer-key', consumer_secret: 'consumer-secret' }), { status: 200 })
  }, { authorizations: [] })
  const flow = createGarminAuthFlow({ fetch: stub.fetch, endpoints: stub.endpoints })

  const outcome = await flow.start('runner@example.com', 'private-garmin-password', 'garmin.cn')
  assert.equal(outcome.status, 'authenticated')
  assert.equal(stub.consumerAttempts(), 2, 'the stalled attempt was retried')
  assert.deepEqual(saved, [{ consumer_key: 'consumer-key', consumer_secret: 'consumer-secret' }])
})

test('a stalled Garmin consumer request retries through the independent transport', async () => {
  forgetGarminOAuthConsumer()
  const calls: string[] = []
  const saved: unknown[] = []
  setGarminConsumerStore({ read: () => null, write: (consumer) => { saved.push(consumer) } })
  const consumer = await obtainGarminOAuthConsumer({
    url: OAUTH_CONSUMER_URL,
    budgetMs: 1000,
    request: (async () => {
      calls.push('primary')
      throw new Error('response body stalled')
    }) as typeof globalThis.fetch,
    retryRequest: (async () => {
      calls.push('fallback')
      return new Response(JSON.stringify({ consumer_key: 'key', consumer_secret: 'secret' }), { status: 200 })
    }) as typeof globalThis.fetch,
  })
  assert.deepEqual(calls, ['primary', 'fallback'])
  assert.deepEqual(consumer, { consumer_key: 'key', consumer_secret: 'secret' })
  assert.deepEqual(saved, [consumer])
})

test('a Garmin consumer reply that is a real answer is not retried', async () => {
  forgetGarminOAuthConsumer()
  const saved: unknown[] = []
  setGarminConsumerStore({ read: () => null, write: (consumer) => { saved.push(consumer) } })
  const stub = stubGarminLogin(() => new Response('denied', { status: 403 }), { authorizations: [] })
  const flow = createGarminAuthFlow({ fetch: stub.fetch, endpoints: stub.endpoints })

  await assert.rejects(() => flow.start('runner@example.com', 'private-garmin-password', 'garmin.cn'), /无法获取 Garmin 应用凭据（HTTP 403）/)
  assert.equal(stub.consumerAttempts(), 1, 'a 4xx is an answer: asking again only burns the budget')
  assert.equal(saved.length, 0)
})

test('a reloaded Garmin backend warms the published consumer from local storage', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-consumer-'))
  const values = new Map<string, string>()
  const security = { get: (id: string) => values.get(id) ?? null, set: (id: string, value: string) => { values.set(id, value) } }
  const backends: BackendManager[] = []
  try {
    forgetGarminOAuthConsumer()
    // Nothing has ever been downloaded: the copy the login has to fetch.
    backends.push(new BackendManager(folder, { secretStore: security }))
    assert.equal(cachedGarminOAuthConsumer(), null)

    // An earlier run saved it. A reloaded backend must come up already holding it,
    // because `fromTokens()` - the first thing a sync does - would otherwise have
    // to reach S3 before the sync could begin.
    values.set('healthpocket-garmin-consumer', JSON.stringify({ consumer_key: 'saved-key', consumer_secret: 'saved-secret' }))
    backends.push(new BackendManager(folder, { secretStore: security }))
    assert.deepEqual(cachedGarminOAuthConsumer(), { consumer_key: 'saved-key', consumer_secret: 'saved-secret' })
  } finally {
    for (const backend of backends) { backend.dispose(); await backend.database.close() }
    await rm(folder, { recursive: true, force: true })
  }
})

test('a failed Garmin login explains which hop failed and keeps a request log', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-diag-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const client = { getTokens: () => tokens, getDisplayName: () => 'Runner' } as GarminClientLike
  let mode: 'ok' | 'bad-credentials' | 'rate-limited' = 'ok'
  const factory: GarminClientFactory = {
    async start() {
      if (mode === 'bad-credentials') throw new GarminLoginError('credentials', 'Garmin 账号或密码不正确，请检查后重试')
      if (mode === 'rate-limited') throw new GarminLoginError('rate-limit', 'Garmin 请求过于频繁，请稍后重试')
      return { status: 'mfa', challenge: {
        method: 'email', target: 'te********@example.com', maskedPhone: null, allowPhone: false,
        async verify() { return tokens },
      } }
    },
    async fromTokens() { return client },
  }
  const backend = new BackendManager(folder, { secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } }, garminClientFactory: factory })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  const login = (api: string, profileId: string, region = 'cn') => fetch(`${api}/garmin/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'runner@example.com', password: 'private-garmin-password', region, profile_id: profileId }),
  })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]

    // A wrong password is not just "Garmin 登录失败": the body names the stage and
    // says which account region to check, which is what the settings page renders.
    mode = 'bad-credentials'
    const rejected = await login(api, profile.id)
    assert.equal(rejected.status, 422)
    const failure = await rejected.json()
    assert.match(failure.detail, /账号或密码不正确/)
    assert.equal(failure.stage, '校验账号密码')
    assert.match(failure.hint, /账号区域|garmin\.cn/)
    assert.ok(failure.failed_at)

    // A rate limit is its own stage with its own advice, not the same sentence.
    mode = 'rate-limited'
    const limited = await (await login(api, profile.id)).json()
    assert.equal(limited.stage, '被 Garmin 限流')
    assert.match(limited.hint, /频率限制/)

    // Local validation never reaches Garmin and is not dressed up as a network fault.
    const invalid = await login(api, profile.id, 'moon')
    assert.equal(invalid.status, 422)
    assert.match((await invalid.json()).detail, /账号区域/)
    // A parked MFA login is a success with its own stage: the user can see that
    // the credentials were accepted and the code is what is pending.
    mode = 'ok'
    const parked = await login(api, profile.id)
    assert.equal(parked.status, 200, await parked.clone().text())
    assert.equal((await parked.json()).mfa.required, true)

    const log = await (await fetch(`${api}/garmin/diagnostics`)).json()
    // Three, not four: the rejected region never became a request, so the request
    // log correctly has nothing to say about it - the form reports it inline.
    assert.equal(log.entries.length, 3)
    // Newest first, so the most recent action is at the top of the panel.
    assert.equal(log.entries[0].action, '登录 Garmin')
    assert.equal(log.entries[0].ok, true)
    assert.equal(log.entries[0].stage, '等待验证码')
    assert.ok(log.entries[0].ms >= 0)
    // Both failures are kept, each with the hop it died on - which is the whole
    // point of the log: two different problems must not read as one wall of text.
    const failures = log.entries.filter((entry: { ok: boolean }) => !entry.ok)
    assert.deepEqual(failures.map((entry: { stage: string }) => entry.stage), ['被 Garmin 限流', '校验账号密码'])
    assert.equal(log.last_failure.stage, '被 Garmin 限流')
    // The log is what the page shows the user; it must never carry the password.
    assert.doesNotMatch(JSON.stringify(log), /private-garmin-password/)

    // Syncing before the parked code is entered is refused, and still explains why.
    const premature = await fetch(`${api}/garmin/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profile.id }),
    })
    assert.equal(premature.status, 502)
    assert.match((await premature.json()).detail, /请先在设置中登录 Garmin Connect/)
  } finally {
    server.closeAllConnections(); server.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('a running Garmin action is visible while it runs, and a stalled one is stopped with its stage named', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-deadline-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const client = { getTokens: () => tokens, getDisplayName: () => 'Runner' } as GarminClientLike
  // A login that never answers at all: the reported shape where the button stays
  // on "正在登录…" and no error ever surfaces.
  const factory: GarminClientFactory = {
    start: () => new Promise(() => {}),
    async fromTokens() { return client },
  }
  const backend = new BackendManager(folder, {
    secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } },
    garminClientFactory: factory,
    garminOptions: { loginDeadlineMs: 1_200 },
  })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]

    const pending = fetch(`${api}/garmin/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'runner@example.com', password: 'private-garmin-password', region: 'cn', profile_id: profile.id }),
    })

    // While it runs the backend must be able to say what it is doing. This is the
    // half that used to be missing: the request log only records finished work,
    // so a stalled action left it empty and "stuck" looked identical to "never
    // sent". The same call is what the settings page polls for progress.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const during = await (await fetch(`${api}/garmin/diagnostics`)).json()
    assert.equal(during.entries.length, 0)
    assert.equal(during.active.action, '登录 Garmin')
    assert.equal(during.active.stage, '提交账号密码')
    assert.ok(during.active.elapsed_ms >= 50, `elapsed_ms should reflect the wait, got ${during.active.elapsed_ms}`)
    assert.equal(during.queue.garmin_active, 1)

    // The deadline then turns the stall into an ordinary, explainable failure
    // instead of a request that never answers.
    const rejected = await pending
    assert.equal(rejected.status, 422)
    const failure = await rejected.json()
    assert.equal(failure.stage, '提交账号密码')
    assert.match(failure.detail, /超过 1 秒仍没有响应/)

    const after = await (await fetch(`${api}/garmin/diagnostics`)).json()
    assert.equal(after.active, null)
    assert.equal(after.entries.length, 1)
    assert.equal(after.entries[0].action, '登录 Garmin')
    assert.equal(after.entries[0].ok, false)
    assert.equal(after.entries[0].stage, '提交账号密码')
    assert.match(after.entries[0].message, /超过 1 秒仍没有响应/)
    // Whatever else it carries, the log must never carry the password.
    assert.doesNotMatch(JSON.stringify(after), /private-garmin-password/)
  } finally {
    server.closeAllConnections(); server.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('a stalled Garmin hop names itself in the failure and in the per-hop request log', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-hop-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const client = { getTokens: () => tokens, getDisplayName: () => 'Runner' } as GarminClientLike
  // The reported shape: Garmin's login endpoint sends its headers and then never
  // finishes the body. Everything before it answered normally.
  const stub = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.includes('oauth_consumer.json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ consumer_key: 'k', consumer_secret: 's' })); return
    }
    if (url.includes('/mobile/sso/en/sign-in')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'CASTGC=stub; Path=/' })
      res.end('<html>stub</html>'); return
    }
    if (url.includes('/mobile/api/login')) {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
      res.write('{"responseStatus":{"type":"MFA_REQ'); return
    }
    res.writeHead(403, { 'content-type': 'text/html' }); res.end('stub')
  })
  // The real flow against the real transport: this is the code path the plugin
  // uses, only with Garmin replaced by a stub that misbehaves the way it did.
  let stubOrigin = ''
  const factory: GarminClientFactory = {
    start: (email, password, domain) => createGarminAuthFlow({ fetch: garminFetch, flowBudgetMs: 7_000, endpoints: {
      sso: () => stubOrigin, service: () => stubOrigin, connectApi: () => stubOrigin,
      consumerUrl: `${stubOrigin}/oauth_consumer.json`, portal: () => stubOrigin,
    } }).start(email, password, domain),
    async fromTokens() { return client },
  }
  const backend = new BackendManager(folder, {
    secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } },
    garminClientFactory: factory,
  })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    stub.listen(0, '127.0.0.1'); await once(stub, 'listening')
    const stubAddress = stub.address(); assert.ok(stubAddress && typeof stubAddress !== 'string')
    stubOrigin = `http://127.0.0.1:${stubAddress.port}`
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]

    const rejected = await fetch(`${api}/garmin/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'runner@example.com', password: 'private-garmin-password', region: 'cn', profile_id: profile.id }),
    })
    assert.equal(rejected.status, 422, await rejected.clone().text())
    const failure = await rejected.json()
    // The failure names the hop that stopped answering instead of the action.
    assert.equal(failure.stage, '提交 Garmin 账号密码')
    assert.match(failure.detail, /没有读完响应内容/)

    const log = await (await fetch(`${api}/garmin/diagnostics`)).json()
    // Hops that answered are recorded too: a log that only lists failures cannot
    // show how far a stalled login actually got.
    const signin = log.requests.find((item: { step: string }) => item.step === '打开 Garmin 登录页')
    assert.ok(signin, 'the hop that answered must be in the log')
    assert.equal(signin.ok, true)
    assert.equal(signin.status, 200)
    const stalled = log.requests.find((item: { step: string }) => item.step === '提交 Garmin 账号密码')
    assert.ok(stalled, 'the stalled hop must be in the log, or the stall stays unexplained')
    assert.equal(stalled.ok, false)
    assert.match(stalled.error, /超时/)
    assert.equal(stalled.status, 200)
    assert.equal(stalled.action, '登录 Garmin')
    assert.ok(stalled.ms >= 6_000, `the hop must be timed, got ${stalled.ms}ms`)
    assert.equal(log.entries[0].stage, '提交 Garmin 账号密码')
    assert.doesNotMatch(JSON.stringify(log), /private-garmin-password/)
  } finally {
    server.closeAllConnections(); server.close()
    stub.closeAllConnections(); stub.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})

test('a wedged Garmin request stops blocking the ones queued behind it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-lane-'))
  const previous = process.env.HEALTHPOCKET_DATA_DIR; process.env.HEALTHPOCKET_DATA_DIR = folder
  const secretValues = new Map<string, string>()
  const tokens: GarminTokens = { oauth1: { oauth_token: 'oauth-one', oauth_token_secret: 'oauth-secret' }, oauth2: {
    scope: '', jti: 'jti', token_type: 'Bearer', access_token: 'oauth-two', refresh_token: 'refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token_expires_in: 7200, refresh_token_expires_at: Math.floor(Date.now() / 1000) + 7200,
  }, displayName: 'Runner' }
  const client = { getTokens: () => tokens, getDisplayName: () => 'Runner' } as GarminClientLike
  let wedged = true
  const factory: GarminClientFactory = {
    async start() {
      // The first attempt takes the lane and does not give it back; every later
      // attempt answers normally. Serializing is still what keeps two logins from
      // racing, but without the watchdog the second attempt would queue behind a
      // request that never finishes - one bad click and the button is dead for
      // the rest of the session.
      if (wedged) await new Promise((resolve) => setTimeout(resolve, 2_000))
      return { status: 'mfa', challenge: {
        method: 'email', target: 'te********@example.com', maskedPhone: null, allowPhone: false,
        async verify() { return tokens },
      } }
    },
    async fromTokens() { return client },
  }
  const backend = new BackendManager(folder, {
    secretStore: { get: (id) => secretValues.get(id) ?? null, set: (id, value) => { secretValues.set(id, value) } },
    garminClientFactory: factory,
    // The per-action ceiling is deliberately out of reach here: this test is
    // about the lane watchdog, which is the safety net for the case where the
    // ceiling itself cannot be trusted.
    garminOptions: { loginDeadlineMs: 600_000 },
    garminLaneStallMs: 250,
  })
  const server = createServer((req, res) => { void backend.proxy(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)) }) })
  try {
    await backend.ensureStarted(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const api = `http://127.0.0.1:${address.port}${API_PREFIX}`
    const profile = (await (await fetch(`${api}/profiles`)).json())[0]
    const login = () => fetch(`${api}/garmin/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'runner@example.com', password: 'private-garmin-password', region: 'cn', profile_id: profile.id }),
    })

    // Abandoned on purpose: it is the wedge, not a subject of this test.
    const first = login(); void first.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    wedged = false

    // The second attempt must still be served, not queued behind the wedge.
    const second = await login()
    assert.equal(second.status, 200, await second.clone().text())
    assert.equal((await second.json()).mfa.required, true)

    const log = await (await fetch(`${api}/garmin/diagnostics`)).json()
    assert.equal(log.queue.garmin_stalls, 1)
    const stall = log.entries.find((entry: { action: string }) => entry.action === '本地请求通道')
    assert.ok(stall, 'freeing the lane must be reported in the same log the user reads')
    assert.match(stall.message, /已放行后续请求/)
  } finally {
    server.closeAllConnections(); server.close()
    if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
    await rm(folder, { recursive: true, force: true })
  }
})
