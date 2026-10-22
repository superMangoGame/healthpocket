import { extractInstitution, extractMeasurements, extractSex, normalizeText, type PageData, type ParsedFinding, type ParsedMeasurement, type ReportSex } from './parser.ts'
import { assessResultText, collapseDoubledPhrases, parseItem } from './report-layout.ts'
import { classifyAnatomy, organOfAnatomy } from '../web/lib/anatomy.ts'
import type { HealthStatus } from './metrics.ts'

/**
 * 病历、出院小结、影像报告和化验单的文字解析。
 *
 * 体检报告有“主检结论 + 分科明细”的固定版式，这些就医资料没有：一张化验单只有
 * 一张表，一份病历里真正有用的是“诊断 / 印象 / 结论”后面那几条。这里只认这两类
 * 信号，指标仍走体检报告同一份指标词典，所以化验单上的数值能和体检数据接成一条趋势。
 */
export const RECORD_PARSER_VERSION = '2026.10-records.1'

/** A PDF with fewer readable characters than this is a scan without a text layer. */
export const MIN_TEXT_CHARS = 24

export interface RecordParse {
  text: string
  measurements: ParsedMeasurement[]
  findings: ParsedFinding[]
  institution: string | null
}

export interface ExtractedDiagnosis { title: string; detail?: string | null }

/** Labels after which a doctor writes conclusions; the first group are diagnoses proper. */
const DIAGNOSIS_LABELS = ['出院诊断', '入院诊断', '初步诊断', '临床诊断', '门诊诊断', '最后诊断', '主要诊断', '其他诊断', '病理诊断', '影像诊断', '影像学诊断', '诊断意见', '诊断']
const CONCLUSION_LABELS = ['检查结论', '检查意见', '超声提示', '超声诊断', '印象', '结论', '意见', '提示']
const LABEL_RE = new RegExp(`^(?:\\d+\\s*[、.．]\\s*)?(${[...DIAGNOSIS_LABELS, ...CONCLUSION_LABELS].join('|')})\\s*[:：]\\s*(.*)$`)
/** Where a conclusion block ends: the next part of the record, or the signature. */
const STOP_RE = /^(?:建议|处理|处置|医嘱|治疗|用药|随访|复诊|复查|检查所见|影像所见|影像表现|超声所见|镜下所见|肉眼所见|主诉|现病史|既往史|个人史|家族史|过敏史|体格检查|查体|辅助检查|报告医师|审核|检查医师|医师|医生|签名|日期|报告日期|报告时间|注[:：]|备注)/
const NUMBERED_RE = /^(?:\d{1,2}(?:[、)）]|[.．](?!\d))|[（(]\d{1,2}[)）]|[①-⑩])/
const SPLIT_RE = /(?:^|(?<=[\s；;。，,]))(?:\d{1,2}(?:[、)）]|[.．](?!\d))|[（(]\d{1,2}[)）]|[①-⑩])\s*|[；;。]/
const ADVICE_RE = /^(?:建议|请|定期|随访|复查|必要时|注意|门诊|随诊)/
const TRAILING_ADVICE_RE = /[，,]\s*(?:建议|请|定期|必要时|随访|复查).*$/
/** Wider than the checkup wording: records say “未见其他异常”“未见明确病变”. */
const NORMAL_RE = /(?:未见|未发现|未查见|未检出|未触及|无)\s*(?:明显|其他|其它|明确|新发)?\s*(?:异常|病变|占位|结节|肿块)/

interface Block { label: string; text: string; page: number }

function conclusionBlocks(pages: PageData[]): Block[] {
  const blocks: Block[] = []
  for (const page of pages) {
    const lines = page.text.split('\n').map((raw) => collapseDoubledPhrases(raw.trim().replace(/\s+/g, ' '))).filter(Boolean)
    for (let index = 0; index < lines.length; index += 1) {
      const match = LABEL_RE.exec(lines[index]!)
      if (!match) continue
      const parts = match[2] ? [match[2]] : []
      for (let next = index + 1; next < lines.length && parts.length < 8; next += 1) {
        const line = lines[next]!
        if (LABEL_RE.test(line) || STOP_RE.test(line)) break
        // A label with nothing after it introduces the lines below; otherwise only a numbered list continues it.
        if (!(NUMBERED_RE.test(line) || (!match[2] && line.length <= 80 && !/[:：]/.test(line)))) break
        parts.push(line); index = next
      }
      if (parts.length) blocks.push({ label: match[1]!, text: parts.join('；'), page: page.number })
    }
  }
  return blocks
}

function splitItems(text: string): string[] {
  return text.split(SPLIT_RE).map((item) => item?.trim().replace(TRAILING_ADVICE_RE, '').replace(/^[，,、:：\s]+|[，,。；;:：\s]+$/g, '') ?? '')
    .filter((item) => item.length >= 2 && item.length <= 120 && !ADVICE_RE.test(item) && /[一-龥A-Za-z]/.test(item))
}

function diagnosisFinding(item: string, label: string, page: number, sex: ReportSex | null, confidence: number): ParsedFinding | null {
  const assessed = NORMAL_RE.test(item) && !/[，,]/.test(item.replace(NORMAL_RE, '')) ? 'normal' : assessResultText(item)
  // A written diagnosis names a condition even without an "abnormal" word ("2 型糖尿病"); a bare 结论 line does not.
  const severity: HealthStatus | null = assessed && assessed !== 'insufficient' ? assessed : DIAGNOSIS_LABELS.includes(label) ? 'attention' : null
  if (!severity) return null
  const anatomy = classifyAnatomy({ text: item, context: label, sex })
  return { title: item.slice(0, 80), content: `${label}：${item}`.slice(0, 300), category: label.includes('诊断') ? '诊断' : '检查结论',
    organ: organOfAnatomy(anatomy), anatomy_id: anatomy, section: label, source: 'conclusion', severity, page, confidence }
}

const compact = (text: string) => text.replace(/[\s，,。；;:：]/g, '')

/** Table rows flagged ↑↓ or outside their reference range that the metric dictionary does not know. */
function abnormalRows(pages: PageData[], measurements: ParsedMeasurement[], sex: ReportSex | null): ParsedFinding[] {
  const known = new Set(measurements.map((item) => compact(item.raw_text)))
  const seen = new Set<string>(); const found: ParsedFinding[] = []
  for (const page of pages) for (const raw of page.text.split('\n')) {
    const line = raw.trim().replace(/\s+/g, ' ')
    const item = line && !known.has(compact(line)) ? parseItem('', line, page.number) : null
    if (!item?.abnormal || seen.has(item.name)) continue
    seen.add(item.name)
    const anatomy = classifyAnatomy({ text: item.name, sex })
    found.push({ title: `${item.name} ${item.flag === '↑' ? '偏高' : item.flag === '↓' ? '偏低' : '异常'}`, content: `${item.name} ${item.value}${item.refText ? `（参考 ${item.refText}）` : ''}`,
      category: '异常条目', organ: organOfAnatomy(anatomy), anatomy_id: anatomy, section: null, source: 'item', severity: 'abnormal', page: item.page, confidence: 0.88 })
  }
  return found
}

/**
 * Parses the text of a medical record. `diagnoses` are what a vision model listed
 * under the record's own diagnosis or conclusion headings; they go through the
 * same severity and anatomy rules as diagnoses found in the text.
 */
export function parseRecordPages(pages: PageData[], diagnoses: ExtractedDiagnosis[] = []): RecordParse {
  const text = pages.map((page) => page.text).join('\n').trim()
  const sex = extractSex(text.slice(0, 6_000))
  const measurements = extractMeasurements(pages, 'unknown')
  const findings: ParsedFinding[] = []; const seen = new Set<string>()
  const add = (finding: ParsedFinding | null) => {
    if (!finding || seen.has(compact(finding.title))) return
    seen.add(compact(finding.title)); findings.push(finding)
  }
  for (const block of conclusionBlocks(pages)) for (const item of splitItems(block.text)) add(diagnosisFinding(item, block.label, block.page, sex, 0.85))
  for (const diagnosis of diagnoses) {
    const title = diagnosis.title.trim().replace(TRAILING_ADVICE_RE, '')
    if (title.length >= 2 && title.length <= 120 && !ADVICE_RE.test(title)) add(diagnosisFinding(title, '诊断', 1, sex, 0.82))
  }
  for (const finding of abnormalRows(pages, measurements, sex)) add(finding)
  return { text, measurements, findings: findings.slice(0, 120), institution: extractInstitution(text.slice(0, 6_000)) }
}

/** One page of text, for what a vision model transcribed from a photo. */
export function pagesFromText(text: string): PageData[] {
  return [{ number: 1, text: normalizeText(text), words: [] }]
}

export const readableLength = (pages: PageData[]) => pages.reduce((total, page) => total + page.text.replace(/\s/g, '').length, 0)
