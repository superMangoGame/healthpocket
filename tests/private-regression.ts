import initSqlJs from 'sql.js'
import wasmBinary from 'sql.js/dist/sql-wasm.wasm'
import { readFileSync } from 'node:fs'
import { parsePdf } from '../src/parser.ts'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

async function main() {
const path = process.env.HEALTHPOCKET_PRIVATE_DB
if (!path) throw new Error('Set HEALTHPOCKET_PRIVATE_DB to a local legacy database; this script never writes to it.')
const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasmBinary).buffer })
const db = new SQL.Database(readFileSync(path))
const rows = (query: string) => { const result = db.exec(query)[0]; return result ? result.values.map((values) => Object.fromEntries(result.columns.map((key, index) => [key, values[index]]))) : [] }
const reports = rows('SELECT id,stored_path,exam_date,template_type FROM reports ORDER BY year,id')
let equalDates = 0; let equalTemplates = 0; let totalOldMetrics = 0; let matchingMetrics = 0; let newMetrics = 0
let totalOldFindings = 0; let matchingFindings = 0; let newFindings = 0
let referenceFindings = 0; let referenceFindingMatches = 0
const differences: Record<string, number> = {}
const findingDifferences: unknown[] = []
for (const report of reports) {
  const parsed = await parsePdf(readFileSync(String(report.stored_path)))
  if (parsed.exam_date === report.exam_date) equalDates++
  if (parsed.template_type === report.template_type) equalTemplates++
  const old = rows(`SELECT canonical_id,value_numeric,value_text,status,page FROM measurements WHERE report_id='${String(report.id).replaceAll("'", "''")}'`)
  totalOldMetrics += old.length; newMetrics += parsed.measurements.length
  for (const item of old) {
    const next = parsed.measurements.find((metric) => metric.canonical_id === item.canonical_id)
    if (next && next.value_numeric === item.value_numeric && next.value_text === item.value_text && next.status === item.status && next.page === item.page) matchingMetrics++
    else differences[String(item.canonical_id)] = (differences[String(item.canonical_id)] ?? 0) + 1
  }
  const oldFindings = rows(`SELECT title,content,organ,severity,page FROM findings WHERE report_id='${String(report.id).replaceAll("'", "''")}'`)
  totalOldFindings += oldFindings.length; newFindings += parsed.findings.length
  const normalizeFinding = (value: unknown) => String(value).replace(/\s+/g, '').replaceAll('：', ':')
  for (const item of oldFindings) if (parsed.findings.some((next) => normalizeFinding(next.title) === normalizeFinding(item.title) && next.organ === item.organ && next.severity === item.severity && next.page === item.page)) matchingFindings++
  const group = (items: Array<{ organ?: unknown; severity?: unknown }>) => items.reduce<Record<string, number>>((counts, item) => { const key = `${String(item.organ)}:${String(item.severity)}`; counts[key] = (counts[key] ?? 0) + 1; return counts }, {})
  const oldCounts = group(oldFindings); const nextCounts = group(parsed.findings)
  if (JSON.stringify(Object.entries(oldCounts).sort()) !== JSON.stringify(Object.entries(nextCounts).sort())) findingDifferences.push({ reportIndex: reports.indexOf(report), oldCounts, nextCounts })
  if (process.env.HEALTHPOCKET_REFERENCE_PYTHON) {
    const reference = JSON.parse(execFileSync(process.env.HEALTHPOCKET_REFERENCE_PYTHON, ['-c',
      'import dataclasses,json,sys;from pathlib import Path;from app.parser import parse_report;print(json.dumps(dataclasses.asdict(parse_report(Path(sys.argv[1]))),default=str))', String(report.stored_path)],
    { env: { ...process.env, PYTHONPATH: join(dirname(path), 'api') }, maxBuffer: 4 * 1024 * 1024 }).toString())
    referenceFindings += reference.findings.length
    for (const item of reference.findings) {
      if (parsed.findings.some((next) => normalizeFinding(next.title) === normalizeFinding(item.title) && next.organ === item.organ && next.severity === item.severity && next.page === item.page)) referenceFindingMatches++
      else if (process.env.HEALTHPOCKET_DEBUG_FINDING) console.log({ referenceTitle: item.title, referenceOrgan: item.organ,
        candidates: parsed.findings.filter((next) => next.page === item.page && next.organ === item.organ).map((next) => ({ title: next.title, status: next.severity })) })
    }
  }
}
db.close()
console.log(JSON.stringify({ reports: reports.length, equalDates, equalTemplates, totalOldMetrics, matchingMetrics, newMetrics, totalOldFindings, matchingFindings, newFindings, referenceFindings, referenceFindingMatches, differences, findingDifferences }, null, 2))
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
