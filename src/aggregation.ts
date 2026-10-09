import type { LocalDatabase } from './database.ts'
import { METRICS, METRIC_BY_ID, RISK_DOMAINS, ORGAN_LABELS, type HealthStatus } from './metrics.ts'
import { NORMAL_FINDING_RE, EXPLANATORY_FINDING_RE } from './parser.ts'
import { collapseDoubledPhrases } from './report-layout.ts'
import { ANATOMY_BY_ID, organOfAnatomy } from '../web/lib/anatomy.ts'
import type { ReportSummary, Measurement, Finding, OrganEvidence } from '../web/lib/types.ts'

export type DbReport = ReportSummary & { stored_path: string; owner_id: string } & Record<string, unknown>
export type DbMeasurement = Measurement & { report_id: string; year: number; exam_date: string | null } & Record<string, unknown>
export type DbFinding = Finding & { report_id: string; year: number } & Record<string, unknown>
type Evidence = OrganEvidence & { risk_key: string }
export const RULES_VERSION = '2026.09.2'
const severity: Record<HealthStatus, number> = { insufficient: 0, normal: 1, attention: 2, abnormal: 3 }
const concepts = [['fatty_liver', '脂肪肝'], ['liver_calcification', '肝内钙化灶'], ['prostate_calcification', '前列腺钙化灶'], ['cervical_straightening', '颈椎生理曲度变直']]
/** 去掉标签、数值括号、措辞后缀，得到可跨来源比较的“发现概念”。 */
function conceptOf(value: string): string {
  const text = collapseDoubledPhrases(value).replace(/^★\s*/, '').replace(/^\d+\s*[、.．]\s*/, '')
  const label = /^([^:：]{1,16})[:：]\s*(.*)$/.exec(text)
  // “检查名:结论”取结论；“指标增高:26.1µmol/L(参考区间…)”冒号后只剩数值，取标签。
  const core = label && /[\u4e00-\u9fa5]{2,}/.test(label[2]!.replace(/参考区间?|结果|范围/g, '')) ? label[2]! : label ? label[1]! : text
  return core.replace(/[(（][^)）]*[)）]?/g, '')
    .replace(/[\s:：;；,.，。、()（）\[\]【】★]/g, '').replace(/^血清/, '').replace(/(?:测定|检测|检查)/g, '')
    .replace(/(?:增高|降低|偏高|偏低|减低|升高|增多|减少|异常|阳性|趋势|待查|可能)+$/, '')
}

function findingKey(item: DbFinding): string {
  const text = conceptOf(item.title)
  const whole = collapseDoubledPhrases(item.title).replace(/\s+/g, '')
  for (const metric of METRICS) {
    const names = [metric.display_name, ...metric.aliases].map(conceptOf).filter((name) => name.length >= 3)
    if (names.some((name) => [text, whole].some((value) => value.includes(name) && !value.includes(`尿${name}`)))) return `metric:${metric.canonical_id}`
  }
  for (const [id, phrase] of concepts) if (phrase && text.includes(phrase)) return `finding:${id}`
  return `finding:${text || item.title}`
}

/** 同一发现在主检结论、章节小结里常以长短不同的措辞重复出现。 */
function sameConcept(a: string, b: string): boolean {
  if (a === b) return true
  if (!a.startsWith('finding:') || !b.startsWith('finding:')) return false
  const left = a.slice(8); const right = b.slice(8)
  return Math.min(left.length, right.length) >= 3 && (left.includes(right) || right.includes(left))
}

const anatomyLabel = (id: string | null | undefined) => (id && ANATOMY_BY_ID.get(id)?.label) || null

export function overallStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((best, current) => severity[current] > severity[best] ? current : best, 'insufficient')
}

export function selectEvidence(evidence: Evidence[]) {
  const seen = new Set<string>()
  const selected = evidence.filter((item) => ['abnormal', 'attention'].includes(item.status))
    .sort((a, b) => severity[b.status] - severity[a.status] || b.confidence - a.confidence || Number(b.kind === 'measurement') - Number(a.kind === 'measurement') || a.title.length - b.title.length)
    .filter((item) => { if ([...seen].some((key) => sameConcept(key, item.risk_key))) return false; seen.add(item.risk_key); return true })
  return { abnormal_count: selected.filter((item) => item.status === 'abnormal').length,
    attention_count: selected.filter((item) => item.status === 'attention').length,
    evidence: selected.map(({ risk_key: _, ...item }) => item) }
}

export const reportSummary = (report: DbReport): ReportSummary => {
  const { id, profile_id, filename, sha256, size_bytes, page_count, exam_date, year, institution, template_type, parse_status, parser_version, created_at } = report
  return { id, profile_id, filename, sha256, size_bytes, page_count, exam_date, year, institution, template_type, parse_status, parser_version, created_at }
}

export class Aggregation {
  constructor(private db: LocalDatabase) {}

  reports(profile: string): DbReport[] {
    return this.db.rows<DbReport>('SELECT * FROM reports WHERE profile_id = :profile ORDER BY year DESC, created_at DESC', { profile })
  }

  private collect(profile: string) {
    const reports = this.reports(profile)
    const years = [...new Set(reports.map((report) => report.year).filter((year): year is number => year !== null))].sort((a, b) => a - b)
    const map = new Map<string, Evidence[]>()
    const add = (year: number, organ: string, item: Evidence) => {
      const key = `${year}:${organ}`; const list = map.get(key) ?? []; list.push(item); map.set(key, list)
    }
    for (const item of this.db.rows<DbMeasurement>(`SELECT m.*, r.year FROM measurements m JOIN reports r ON r.id=m.report_id
      WHERE r.profile_id=:profile AND r.year IS NOT NULL AND m.confidence>=0.8`, { profile })) {
      const anatomy = (item.anatomy_id as string | null) || METRIC_BY_ID.get(item.canonical_id)?.anatomy || null
      const organ = anatomy ? organOfAnatomy(anatomy) : item.organ
      if (!organ) continue
      let reason = '缺少可靠判定依据'
      if (item.flag) reason = `原报告标记 ${item.flag}`
      else if (item.value_numeric !== null && item.ref_low !== null && item.value_numeric < item.ref_low) reason = `低于参考下限 ${item.ref_low}`
      else if (item.value_numeric !== null && item.ref_high !== null && item.value_numeric > item.ref_high) reason = `高于参考上限 ${item.ref_high}`
      else if (item.value_numeric !== null && (item.ref_low !== null || item.ref_high !== null)) reason = '结果位于参考范围内'
      else if (item.value_text) reason = `报告结果：${item.value_text}`
      add(item.year, organ, { kind: 'measurement', title: METRIC_BY_ID.get(item.canonical_id)?.display_name ?? item.raw_name,
        value: item.value_text ?? (item.value_numeric === null ? null : `${item.value_numeric} ${item.unit ?? ''}`.trim()),
        reference: item.ref_text, status: item.status, flag: item.flag, status_reason: reason, confidence: item.confidence,
        report_id: item.report_id, page: item.page, anatomy_id: anatomy, anatomy_label: anatomyLabel(anatomy), risk_key: `metric:${item.canonical_id}` })
    }
    const sourceReasons: Record<string, string> = { conclusion: '来自主检结论', summary: '来自分项小结', item: '明细表异常标记' }
    for (const item of this.db.rows<DbFinding>(`SELECT f.*, r.year FROM findings f JOIN reports r ON r.id=f.report_id
      WHERE r.profile_id=:profile AND r.year IS NOT NULL AND f.confidence>=0.8`, { profile })) {
      const anatomy = (item.anatomy_id as string | null) || null
      const organ = anatomy ? organOfAnatomy(anatomy) : item.organ
      const text = `${item.title} ${item.content}`
      if (!organ || (item.severity !== 'normal' && (NORMAL_FINDING_RE.test(text) || EXPLANATORY_FINDING_RE.test(text)))) continue
      add(item.year, organ, { kind: 'finding', title: item.title, value: item.content, reference: null, status: item.severity,
        flag: null, status_reason: sourceReasons[String(item.source)] ?? '来自报告结论', confidence: item.confidence, report_id: item.report_id, page: item.page,
        anatomy_id: anatomy, anatomy_label: anatomyLabel(anatomy), risk_key: findingKey(item) })
    }
    return { reports, years, map }
  }

  dashboard(profile: string) {
    const { reports, years, map } = this.collect(profile)
    const cell = (year: number, items: Evidence[]) => {
      const { abnormal_count, attention_count } = selectEvidence(items)
      return { year, status: overallStatus(items.map((item) => item.status)), abnormal_count, attention_count, evidence_count: abnormal_count + attention_count }
    }
    return { report_count: reports.length, year_from: years[0] ?? null, year_to: years.at(-1) ?? null,
      years: years.map((year) => cell(year, [...map].filter(([key]) => key.startsWith(`${year}:`)).flatMap(([, items]) => items))),
      latest_reports: reports.slice(0, 8).map(reportSummary),
      recent_findings: this.db.rows(`SELECT f.id,f.title,f.content,f.severity,r.year,r.id AS report_id,f.page FROM findings f JOIN reports r ON r.id=f.report_id WHERE r.profile_id=:profile AND f.severity IN ('abnormal','attention') ORDER BY r.year DESC,f.severity DESC LIMIT 8`, { profile }),
      risk_matrix: RISK_DOMAINS.map(([id, label, organs]) => ({ id, label, years: years.map((year) => cell(year, organs.flatMap((organ) => map.get(`${year}:${organ}`) ?? []))) })) }
  }

  riskDetail(profile: string, domain: string, year: number) {
    const entry = RISK_DOMAINS.find(([id]) => id === domain)
    if (!entry) return null
    const { map } = this.collect(profile)
    return { domain_id: domain, label: entry[1], year, ...selectEvidence(entry[2].flatMap((organ) => map.get(`${year}:${organ}`) ?? [])) }
  }

  timeline(profile: string, organ: string) {
    if (!ORGAN_LABELS[organ]) return null
    const { years, map } = this.collect(profile)
    return { organ, label: ORGAN_LABELS[organ], rules_version: RULES_VERSION, years: years.map((year) => {
      const items = map.get(`${year}:${organ}`) ?? []
      return { year, status: overallStatus(items.map((item) => item.status)), ...selectEvidence(items) }
    }) }
  }

  trendRows(profile: string, canonical?: string) {
    return this.db.rows<DbMeasurement>(`SELECT m.*,r.year,r.exam_date FROM measurements m JOIN reports r ON r.id=m.report_id
      WHERE r.profile_id=:profile AND r.year IS NOT NULL AND m.confidence>=0.8 AND (m.value_numeric IS NOT NULL OR m.value_text IS NOT NULL)
      ${canonical ? 'AND m.canonical_id=:canonical' : ''} ORDER BY r.year,r.exam_date`, { profile, ...(canonical ? { canonical } : {}) })
  }

  trend(profile: string, canonical: string, unit: string | null) {
    const metric = METRIC_BY_ID.get(canonical)
    if (!metric) return null
    const rows = this.trendRows(profile, canonical)
    const units = [...new Set(rows.map((item) => item.unit).filter((item): item is string => Boolean(item)))].sort()
    if (unit && !units.includes(unit)) throw new Error('该指标不存在指定单位的趋势序列')
    const selected = unit || [...units].sort((a, b) => rows.filter((item) => item.unit === b).length - rows.filter((item) => item.unit === a).length)[0] || null
    return { canonical_id: canonical, display_name: metric.display_name, category: metric.category, organ: metric.organ,
      selected_unit: selected, available_units: units, points: rows.filter((item) => item.unit === selected).map((item) => {
        const { report_id, year, exam_date, value_numeric, value_text, unit, ref_low, ref_high, ref_text, status, confidence, page } = item
        return { report_id, year, exam_date, value_numeric, value_text, unit, ref_low, ref_high, ref_text, status, confidence, page }
      }) }
  }
}
