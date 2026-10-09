import { getDocument, PDFWorker, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { MessageChannel } from 'node:worker_threads'
import { METRICS, type HealthStatus, type MetricSpec } from './metrics.ts'
import { classifyAnatomy, anatomyTargets, matchAnatomy, organOfAnatomy } from '../web/lib/anatomy.ts'
import { extractLayout, assessResultText, hasAbnormalWord, collapseDoubledCjk, collapseDoubledPhrases, parseReference, RANGE_RE, UPPER_RE, LOWER_RE,
  SKIP_RESULT_RE, type ReportLayout } from './report-layout.ts'

export { collapseDoubledCjk }
export type ReportSex = 'female' | 'male'

export interface PageData {
  number: number
  text: string
  words: Array<{ text: string; x0: number; top: number; x1: number; bottom: number }>
}

export interface ParsedMeasurement {
  canonical_id: string
  raw_name: string
  abbreviation: string | null
  value_numeric: number | null
  value_text: string | null
  unit: string | null
  ref_low: number | null
  ref_high: number | null
  ref_text: string | null
  flag: string | null
  status: HealthStatus
  category: string
  organ: string | null
  anatomy_id: string
  confidence: number
  page: number
  bbox: number[] | null
  raw_text: string
}

/** 来源：主检结论、章节小结、明细表中的异常条目。 */
export type FindingSource = 'conclusion' | 'summary' | 'item'

export interface ParsedFinding {
  title: string
  content: string
  category: string
  organ: string | null
  anatomy_id: string
  section: string | null
  source: FindingSource
  severity: HealthStatus
  page: number
  confidence: number
}

export interface ParsedReport {
  page_count: number
  exam_date: string | null
  year: number | null
  institution: string | null
  template_type: string
  sex: ReportSex | null
  measurements: ParsedMeasurement[]
  findings: ParsedFinding[]
  used_ocr: boolean
}

const NUMBER_RE = /(?<![\d./-])([<>≤≥]?\s*-?\d+(?:\.\d+)?)(?![\d./-])/
const ROMAN_VALUES: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, 'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4 }
const ROMAN_RE = /(?<![A-ZⅠⅡⅢⅣ])(IV|III|II|I|Ⅳ|Ⅲ|Ⅱ|Ⅰ)(?:度)?(?![A-ZⅠⅡⅢⅣ])/g

export const NORMAL_FINDING_RE = /(?:未见|未触及|未扪及|未闻及|未发现|未查见|未检出|无)\s*(?:明显)?\s*异常/
export const EXPLANATORY_FINDING_RE = /(?:大多数无任何症状|发生与.{0,60}有关|最常见的原因|出现类似.{0,30}沉淀|所遗留|可由.{0,30}引起|不能完全肯定患者|主要用于.{0,30}筛查|是一种.{0,40}细菌|异常[，,]\s*或有.{0,50}(?:高危因素|请在专科医生指导下))/

function normalizeText(text: string): string {
  return text.replaceAll('μ', 'µ').replaceAll('～', '~').replaceAll('—', '-').replaceAll('–', '-')
    .replaceAll('（', '(').replaceAll('）', ')').replaceAll('：', ':')
}

function cleanUnit(text: string): string | null {
  let value = text.trim().replace(/^[-:|,;()\[\]\s]+|[-:|,;()\[\]\s]+$/g, '').replace(/\s+/g, '').replaceAll('µ', 'μ')
  if (value.endsWith('/')) value += 'L'
  if (!value || ['↑', '↓', '正常', '阴性', '阳性'].includes(value)) return null
  value = value.replace(/^已复查/, '')
  return value.slice(0, 80) || null
}

export function metricStatus(value: number | null, valueText: string | null, flag: string | null, low: number | null, high: number | null): HealthStatus {
  if (flag && ['↑', '↓', 'H', 'L', '+'].includes(flag)) return 'abnormal'
  if (valueText) {
    if (['阳性', '异常', '偏高', '偏低', '+'].some((token) => valueText.includes(token))) return 'abnormal'
    if (['阴性', '正常', '未见'].some((token) => valueText.includes(token))) return 'normal'
    return 'insufficient'
  }
  if (value === null) return 'insufficient'
  if (low !== null && value < low) return 'abnormal'
  if (high !== null && value > high) return 'abnormal'
  return low !== null || high !== null ? 'normal' : 'insufficient'
}

export function extractExamDate(text: string): string | null {
  const patterns = [
    /(?:检查日期|体检时间|检查时间)\s*[:：]?\s*(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})/,
    /(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})日?/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (!match) continue
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
    }
  }
  return null
}

export function detectTemplate(text: string, examDate: string | null = null): string {
  const year = examDate ? Number(examDate.slice(0, 4)) : null
  if (text.includes('爱康国宾')) return 'ikang-2018-2020'
  if (text.includes('健康体检报告导读') || (year !== null && year >= 2024 && text.includes('常见体检数据对比'))) return 'health100-2024-2025'
  if (text.includes('报告阅读说明') || text.includes('报 告 阅 读 说 明') || (year !== null && year >= 2021 && year <= 2023 && text.includes('检查项目名称'))) return 'health100-2021-2023'
  return 'unknown'
}

/** 未匹配到已知机构时，只要通用版式识别出足够的明细章节就按通用模板处理。 */
export function resolveTemplate(detected: string, layout: ReportLayout): string {
  return detected === 'unknown' && layout.sections.length >= 3 ? 'generic' : detected
}

const INSTITUTION_SUFFIX = '(?:医院|门诊部|体检中心|健康管理中心|健康体检中心|分院|诊所|卫生院|保健院|医学中心)'

export function extractInstitution(text: string): string | null {
  const labeled = /(?:检查机构|体检机构|体检中心|医疗机构|体检医院|检查医院)\s*[:：]\s*([^\n]{2,40})/.exec(text)
  if (labeled?.[1]) return labeled[1].trim().replace(/\s+/g, ' ').split(/\s{2,}|先生|女士/)[0]!.trim().slice(0, 255)
  for (const line of text.split('\n')) {
    if (/单位名称|工作单位|公司名称/.test(line)) continue
    const match = new RegExp(`([\\u4e00-\\u9fa5()（）]{2,30}${INSTITUTION_SUFFIX})`).exec(line.replace(/\s+/g, ''))
    if (match?.[1] && !/^(?:感谢|欢迎|尊敬|请到|前往|及时)/.test(match[1])) return match[1].replace(/^(?:[\u4e00-\u9fa5]*?(?:感谢您对|欢迎来到|欢迎您选择))/, '').slice(0, 255)
  }
  return null
}

export function extractSex(text: string): ReportSex | null {
  const labeled = /性\s*别\s*[:：]?\s*(男|女)/.exec(text)
  if (labeled) return labeled[1] === '女' ? 'female' : 'male'
  if (/女士/.test(text)) return 'female'
  if (/先生/.test(text)) return 'male'
  return null
}

function findBbox(words: PageData['words'], term: string): number[] | null {
  const compact = term.replaceAll(' ', '')
  const found = words.find((word) => compact && word.text.replaceAll(' ', '').includes(compact))
  return found ? [found.x0, found.top, found.x1, found.bottom] : null
}

function combinedBloodPressure(metric: MetricSpec, line: string, anchor: string, page: PageData, template: string): ParsedMeasurement | null {
  if (!['systolic_bp', 'diastolic_bp'].includes(metric.canonical_id)) return null
  const reading = /\((?<systolic>\d{2,3})\s*\/\s*(?<diastolic>\d{2,3})\s*mmHg\)/i.exec(line)
  if (!reading?.groups || !line.includes('收缩压') || !line.includes('舒张压')) return null
  const label = metric.canonical_id === 'systolic_bp' ? '收缩压' : '舒张压'
  const range = new RegExp(`${label}\\s*(\\d+(?:\\.\\d+)?)\\s*(?:--|[-~～至])\\s*(\\d+(?:\\.\\d+)?)`).exec(line)
  const low = range ? Number(range[1]) : null; const high = range ? Number(range[2]) : null
  const value = Number(reading.groups[metric.canonical_id === 'systolic_bp' ? 'systolic' : 'diastolic'])
  return {
    canonical_id: metric.canonical_id, raw_name: anchor, abbreviation: metric.abbreviation, value_numeric: value, value_text: null,
    unit: metric.canonical_unit, ref_low: low, ref_high: high, ref_text: range ? range[0].replace(label, '').trim() : null,
    flag: null, status: line.includes('正常高值血压') ? 'attention' : metricStatus(value, null, null, low, high), category: metric.category,
    organ: metric.organ, anatomy_id: metric.anatomy, confidence: template !== 'unknown' ? 0.93 : 0.78, page: page.number, bbox: findBbox(page.words, anchor), raw_text: line,
  }
}

function lineForMetric(page: PageData, metric: MetricSpec): [string, string] | null {
  const candidates = [...metric.aliases].sort((a, b) => b.length - a.length)
  const lines = page.text.split('\n'); const matches: Array<[number, string, string]> = []
  lines.forEach((rawLine, index) => {
    let line = rawLine.trim().replace(/\s+/g, ' ')
    if (metric.canonical_id === 'uric_acid' && line.includes('尿酸碱度')) return
    if (['t3', 't4'].includes(metric.canonical_id) && line.includes('游离')) return
    for (const alias of candidates) {
      if (!line.includes(alias)) continue
      if (metric.canonical_id === 'tct' && !['未见', '阴性', '阳性', '异常', 'NILM', '炎症'].some((word) => line.includes(word))) {
        const neighbors = lines.slice(Math.max(0, index - 1), index + 2).filter((item) => item !== rawLine).map((item) => item.trim()).join(' ')
        if (['未见', '阴性', '阳性', '异常', 'NILM', '炎症'].some((word) => neighbors.includes(word))) line += ` ${neighbors}`
      }
      let score = line.startsWith(alias) || line.startsWith(`★ ${alias}`) ? 2 : 0
      if (parseReference(line)[2]) score += 2
      if (metric.canonical_id === 'hpv') score += line.includes('阳性') ? 8 : line.includes('阴性') ? 4 : -8
      if (metric.canonical_id === 'hpv' && line.includes('型')) score += 2
      if (metric.canonical_id === 'tct' && ['未见上皮内病变', 'NILM', '炎症'].some((word) => line.includes(word))) score += 5
      if (metric.canonical_id === 'birads') score += line.includes('乳腺结节') && /BI-RADS\s*\d/i.test(line) ? 5 : -3
      if (['医学解释', '什么是', '世界卫生组织'].some((word) => line.includes(word))) score -= 3
      matches.push([score, line, alias]); break
    }
    if (metric.abbreviation && new RegExp(`(?:\\(|\\s)${escapeRegex(metric.abbreviation)}(?:\\)|\\s)`, 'i').test(line)) matches.push([1, line, metric.abbreviation])
  })
  matches.sort((a, b) => b[0] - a[0])
  return matches[0] ? [matches[0][1], matches[0][2]] : null
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function parseMetricLine(metric: MetricSpec, line: string, anchor: string, page: PageData, template: string): ParsedMeasurement | null {
  const bloodPressure = combinedBloodPressure(metric, line, anchor, page, template)
  if (bloodPressure) return bloodPressure
  let tail = line.slice(line.indexOf(anchor) + anchor.length)
  if (metric.abbreviation) {
    const match = new RegExp(escapeRegex(metric.abbreviation), 'i').exec(tail)
    if (match && match.index < 32) tail = tail.slice(match.index + match[0].length)
  }
  tail = tail.replace(/^[ )\]】:：-]+/, '').replace(/^0h\b\s*/i, '')
  let flag = /(?:^|\s)(↑|↓|H|L|\+)(?:\s|$)/.exec(tail)?.[1] ?? null
  if (!flag && ['偏高', '增高', '升高'].some((word) => line.includes(word))) flag = '↑'
  if (!flag && ['偏低', '降低'].some((word) => line.includes(word))) flag = '↓'
  let [low, high, refText] = parseReference(tail)
  const base = { canonical_id: metric.canonical_id, raw_name: anchor, abbreviation: metric.abbreviation, category: metric.category, organ: metric.organ, anatomy_id: metric.anatomy, page: page.number, bbox: findBbox(page.words, anchor), raw_text: line }

  if (metric.canonical_id === 'vaginal_cleanliness') {
    ROMAN_RE.lastIndex = 0; const matches = [...tail.toUpperCase().matchAll(ROMAN_RE)]; ROMAN_RE.lastIndex = 0
    if (!matches[0]?.[1]) return null
    const value = ROMAN_VALUES[matches[0][1]]!
    const refs = matches.slice(1).map((item) => item[1] ? ROMAN_VALUES[item[1]] : undefined).filter((item): item is number => item !== undefined)
    if (refs.length) { low = Math.min(...refs); high = Math.max(...refs); refText = low === high ? `${low}` : `${low}-${high}` }
    return { ...base, value_numeric: value, value_text: null, unit: metric.canonical_unit, ref_low: low, ref_high: high, ref_text: refText, flag, status: metricStatus(value, null, flag, low, high), confidence: template !== 'unknown' ? 0.94 : 0.82 }
  }
  if (metric.value_type === 'text') {
    const valueText = /(阴性|阳性|弱阳性|未见|正常|异常|\+{1,4}|-{1,4})/.exec(tail)?.[1] ?? null
    if (!valueText) return null
    let status = metricStatus(null, valueText, flag, low, high)
    if (metric.canonical_id === 'tct' && ['炎症', '建议炎症消退后', '建议复查'].some((word) => line.includes(word))) status = 'attention'
    return { ...base, value_numeric: null, value_text: valueText, unit: null, ref_low: low, ref_high: high, ref_text: refText, flag, status, confidence: template !== 'unknown' ? 0.92 : 0.72 }
  }
  let searchFrom = 0
  if (metric.canonical_id === 'bmi' && refText) {
    RANGE_RE.lastIndex = 0; const range = RANGE_RE.exec(tail); RANGE_RE.lastIndex = 0
    if (range && !tail.slice(0, range.index).replace(/[ ()\[\]]/g, '')) searchFrom = range.index + range[0].length
  }
  const numberMatch = NUMBER_RE.exec(tail.slice(searchFrom))
  if (!numberMatch) return null
  const numberStart = searchFrom + numberMatch.index; const numberEnd = numberStart + numberMatch[0].length
  const value = Number(numberMatch[1]!.replace(/[<>≤≥\s]/g, ''))
  if (!Number.isFinite(value)) return null
  const afterValue = tail.slice(numberEnd)
  let unitEnd = afterValue.length
  for (const regex of [RANGE_RE, UPPER_RE, LOWER_RE]) { regex.lastIndex = 0; const match = regex.exec(afterValue); if (match) unitEnd = Math.min(unitEnd, match.index); regex.lastIndex = 0 }
  let unit = cleanUnit(afterValue.slice(0, unitEnd).replace(/(?:↑|↓|\bH\b|\bL\b|已复查)/g, ''))
  if (['ca125', 'ca153', 'birads'].includes(metric.canonical_id)) unit = metric.canonical_unit
  if (unit && (unit.includes('范围') || unit.includes('参考') || unit.length > 24)) unit = metric.canonical_unit
  // 带参考区间的表格行即使来自未知机构也足够可靠。
  const confidence = refText ? (template !== 'unknown' ? 0.96 : 0.9) : template !== 'unknown' ? 0.86 : 0.68
  return { ...base, value_numeric: value, value_text: null, unit: unit ?? metric.canonical_unit, ref_low: low, ref_high: high, ref_text: refText, flag, status: metricStatus(value, null, flag, low, high), confidence }
}

export function extractMeasurements(pages: PageData[], template: string): ParsedMeasurement[] {
  const best = new Map<string, ParsedMeasurement>()
  for (const metric of METRICS) for (const page of pages) {
    const located = lineForMetric(page, metric); if (!located) continue
    const parsed = parseMetricLine(metric, located[0], located[1], page, template); if (!parsed) continue
    const previous = best.get(metric.canonical_id)
    const quality = (item: ParsedMeasurement) => item.confidence + (item.ref_low !== null && item.ref_high !== null ? 0.08 : item.ref_text ? 0.03 : 0) + (item.unit ? 0.03 : 0)
    if (!previous || quality(parsed) > quality(previous)) best.set(metric.canonical_id, parsed)
  }
  return [...best.values()].sort((a, b) => a.category.localeCompare(b.category, 'zh-CN') || a.page - b.page || a.canonical_id.localeCompare(b.canonical_id))
}

const labelOf = (text: string) => /^([^:：]{1,16})[:：]/.exec(text)?.[1]?.trim() ?? null

const EXPLANATORY_WORDS = ['则', '若', '可见于', '可由', '由于', '例如', '如急性', '一般', '通常', '引起', '许多', '分为', '是指', '称为', '多见于', '常见于', '什么是',
  '提示您', '建议您', '旨在', '多与', '您的', '您本次']
const ADVICE_START_RE = /^(?:建议|请|避免|定期|多为|可能与|一般|本次|如有|若|注意|保持|发病|常见|是一种|无需|依据|伴有|结合|\d+\s*[-~]?\s*\d*\s*个?月|品。|[，。,；;])/
const PURE_ADVICE_RE = /^(?:建议|定期|随访|观察|请|注意|保持|避免|如有|必要时|是|[(（])/

/**
 * 两栏排版会把结论与右栏的医生建议拼在同一行。结论本身很少含空格，
 * 所以在第一个“像建议或说明”的片段处截断：以建议措辞开头，或者是一段长的中文叙述。
 */
function findingTitle(text: string): string {
  const stripped = text.replace(/^★\s*/, '').replace(/^【\s*\d+\s*】\s*/, '').replace(/^\d+\s*[、.．]\s*/, '').replace(/^\d+\s+(?=[\u4e00-\u9fa5])/, '')
    .replace(/^(?:小结|初步意见|结论|检查结果)\s*/, '')
  const tokens = stripped.replace(/[，,；;。]\s*(?:建议|请|定期|必要时).*$/, '').split(/\s+/).filter(Boolean)
  const kept: string[] = []
  for (const token of tokens) {
    if (kept.length && (ADVICE_START_RE.test(token) || (token.length >= 10 && /[\u4e00-\u9fa5]/.test(token) && /[，。、]/.test(token)))) break
    kept.push(token)
  }
  return kept.join(' ').replace(/[，,；;。]\s*(?:建议|请|定期|必要时).*$/, '').replace(/[，,。；;:：\s]+$/, '').trim().slice(0, 80)
}

/** “检查名:结论”先按结论内容归类，检查名只作上下文，避免“胸部CT:右肺钙化灶”落到胸廓。 */
function classifyText(text: string, context: string | null, sex: ReportSex | null): string {
  const label = labelOf(text)
  if (!label) return classifyAnatomy({ text, context, sex })
  const content = text.slice(text.search(/[:：]/) + 1)
  return matchAnatomy(content, sex).length ? classifyAnatomy({ text: content, context: label, sex }) : classifyAnatomy({ text: label, context, sex })
}

const explanatory = (text: string) => EXPLANATORY_WORDS.some((word) => text.includes(word)) || EXPLANATORY_FINDING_RE.test(text) || /^(?:是|多与|可引发|指)/.test(text)
const compactKey = (text: string) => collapseDoubledPhrases(text).replace(/\s+/g, '')

function finding(input: Omit<ParsedFinding, 'organ' | 'category' | 'confidence'> & { confidence?: number }): ParsedFinding {
  return { ...input, organ: organOfAnatomy(input.anatomy_id), category: input.source === 'conclusion' ? '报告结论' : input.source === 'summary' ? '分项小结' : '异常条目',
    confidence: input.confidence ?? 0.86 }
}

/** 主检结论 / 阳性结果汇总：只收异常与关注项，按所在分组（如“★ 乳腺彩超”）提供解剖上下文。 */
function conclusionFindings(layout: ReportLayout, sex: ReportSex | null): ParsedFinding[] {
  const found: ParsedFinding[] = []; const seen = new Set<string>()
  for (const entry of layout.conclusions) {
    const line = entry.text.replace(/^【\s*(\d+)\s*】\s*/, '$1、')
    if (line.length < 4 || line.length > 180 || NORMAL_FINDING_RE.test(line) && !hasAbnormalWord(line.replace(NORMAL_FINDING_RE, ''))) continue
    if (EXPLANATORY_FINDING_RE.test(line) || (PURE_ADVICE_RE.test(line) && !line.includes('趋势'))) continue
    // 上一行折行留下的尾巴，如“2类)可能 ……”。
    if (/^[\w-]*\s*类?[)）]/.test(line)) continue
    const title = findingTitle(line)
    if (title.length < 2 || (explanatory(title) && title.length > 24) || /^(?:是|多与|可引发|指)/.test(title)) continue
    const severity = title.includes('趋势') ? 'attention' : assessResultText(title)
    if (severity !== 'abnormal' && severity !== 'attention') continue
    const prefix = title.split(/[:：;；,.，。]/, 1)[0] ?? ''
    const numbered = /^(?:\d+\s*[、.．]|\d+\s+[\u4e00-\u9fa5]|★)/.test(line)
    const concise = title.length <= 48 && hasAbnormalWord(prefix) && !explanatory(title)
    const labeled = title.length <= 72 && /[:：]/.test(title) && matchAnatomy(prefix, sex).length > 0
    const grouped = entry.group !== null && title.length <= 40 && !explanatory(title)
    if (!(numbered || concise || labeled || grouped)) continue
    const key = compactKey(title)
    if (seen.has(key)) continue
    seen.add(key)
    found.push(finding({ title, content: line, anatomy_id: classifyText(title, entry.group, sex), section: entry.group,
      source: 'conclusion', severity, page: entry.page }))
  }
  return found
}

/** 章节小结：异常项归到具体部位；“未见异常”作为该章节所覆盖部位的正常证据。 */
function summaryFindings(layout: ReportLayout, sex: ReportSex | null): ParsedFinding[] {
  const found: ParsedFinding[] = []; const seen = new Set<string>()
  for (const summary of layout.summaries) for (const part of summary.text.split(/[；;]/)) {
    const text = part.trim()
    if (text.length < 2 || SKIP_RESULT_RE.test(text) || explanatory(text)) continue
    const severity = assessResultText(findingTitle(text) || text)
    if (!severity || severity === 'insufficient') continue
    const label = labelOf(text)
    const bare = (value: string) => value.replace(/[(（][^)）]*[)）]/g, '')
    const own = severity === 'normal' ? anatomyTargets(bare(label ?? text), sex) : []
    const targets = severity !== 'normal' ? [classifyText(text, summary.section, sex)]
      : own.length ? own : anatomyTargets(bare(summary.section), sex)
    for (const anatomy of targets) {
      const key = `${anatomy}:${compactKey(text)}`
      if (seen.has(key)) continue
      seen.add(key)
      const title = severity === 'normal' ? `${summary.section}：${text}`.slice(0, 80) : findingTitle(text)
      found.push(finding({ title, content: text, anatomy_id: anatomy, section: summary.section, source: 'summary', severity, page: summary.page }))
    }
  }
  return found
}

/** 明细表里带 ↑↓ 或超出参考区间、但不在固定指标词典中的条目。 */
function itemFindings(layout: ReportLayout, measurements: ParsedMeasurement[], sex: ReportSex | null): ParsedFinding[] {
  const known = new Set(measurements.map((item) => compactKey(item.raw_text)))
  const found: ParsedFinding[] = []; const seen = new Set<string>()
  for (const item of layout.items) {
    if (!item.abnormal || known.has(compactKey(item.raw.replace(/^★\s*/, ''))) || seen.has(item.name)) continue
    seen.add(item.name)
    const direction = item.flag === '↑' ? '偏高' : item.flag === '↓' ? '偏低' : '异常'
    found.push(finding({ title: `${item.name} ${direction}`, content: `${item.name} ${item.value}${item.refText ? `（参考 ${item.refText}）` : ''}`,
      anatomy_id: classifyAnatomy({ text: item.name, context: item.section, sex }), section: item.section, source: 'item', severity: 'abnormal', page: item.page, confidence: 0.9 }))
  }
  return found
}

export function extractFindings(pages: PageData[], options: { measurements?: ParsedMeasurement[]; sex?: ReportSex | null; layout?: ReportLayout } = {}): ParsedFinding[] {
  const layout = options.layout ?? extractLayout(pages)
  const sex = options.sex ?? null
  return [...conclusionFindings(layout, sex), ...summaryFindings(layout, sex), ...itemFindings(layout, options.measurements ?? [], sex)].slice(0, 300)
}

async function withPdf<T>(content: Uint8Array, work: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  // Both ends run bundled code, without loading a worker script from disk or a CDN.
  const { port1, port2 } = new MessageChannel()
  port1.start(); port2.start()
  WorkerMessageHandler.initializeFromPort(port1)
  // PDF.js 4's generated types incorrectly infer the supported `port` option as null.
  const worker = new PDFWorker({ port: port2 } as unknown as ConstructorParameters<typeof PDFWorker>[0])
  const task = getDocument({ data: new Uint8Array(content), worker, useSystemFonts: true, isEvalSupported: false,
    disableFontFace: true })
  task.onPassword = () => { void task.destroy() }
  try {
    const pdf = await task.promise
    if (pdf.numPages > 300) throw new Error('PDF 页数不能超过 300 页')
    return await work(pdf)
  } finally { await task.destroy(); worker.destroy(); port1.close(); port2.close() }
}

export async function inspectPdf(content: Uint8Array): Promise<number> {
  return withPdf(content, async (pdf) => pdf.numPages)
}

async function extractPdfPages(content: Uint8Array): Promise<PageData[]> {
  return withPdf(content, async (pdf) => {
  const pages: PageData[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber); const textContent = await page.getTextContent()
    const rows = new Map<number, Array<{ text: string; x: number; width: number; height: number }>>()
    for (const rawItem of textContent.items) {
      if (!('str' in rawItem) || !('transform' in rawItem)) continue
      const item = rawItem as { str: string; transform: number[]; width: number; height: number }
      const x = item.transform[4] ?? 0; const y = item.transform[5] ?? 0; const key = Math.round(y / 3) * 3
      const row = rows.get(key) ?? []; row.push({ text: item.str, x, width: item.width, height: item.height }); rows.set(key, row)
    }
    const sortedRows = [...rows.entries()].sort((a, b) => b[0] - a[0])
    const words: PageData['words'] = []; const lines: string[] = []
    for (const [y, row] of sortedRows) {
      row.sort((a, b) => a.x - b.x)
      let line = ''; let end: number | null = null
      for (const item of row) {
        if (end !== null && item.x - end > 2) line += ' '
        line += item.text; end = item.x + item.width
        const top = page.view[3]! - y - item.height
        words.push({ text: item.text, x0: item.x, top, x1: item.x + item.width, bottom: top + item.height })
      }
      lines.push(line.replace(/\s+/g, ' ').trim())
    }
    pages.push({ number: pageNumber, text: normalizeText(lines.join('\n')), words })
    page.cleanup()
  }
  return pages
  })
}

export async function parsePdf(content: Uint8Array): Promise<ParsedReport> {
  const pages = await extractPdfPages(new Uint8Array(content))
  const allText = pages.map((page) => page.text).join('\n')
  const head = allText.slice(0, 12_000)
  const examDate = extractExamDate(head)
  const layout = extractLayout(pages)
  const template = resolveTemplate(detectTemplate(head, examDate), layout)
  const sex = extractSex(allText.slice(0, 6_000))
  const measurements = extractMeasurements(pages, template)
  return {
    page_count: pages.length, exam_date: examDate, year: examDate ? Number(examDate.slice(0, 4)) : null,
    institution: extractInstitution(allText.slice(0, 6_000)), template_type: template, sex,
    measurements, findings: extractFindings(pages, { measurements, sex, layout }), used_ocr: false,
  }
}
