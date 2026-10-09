import type { HealthStatus } from './metrics.ts'

/**
 * 与体检机构无关的版式抽取。
 *
 * 几乎所有体检报告都由两部分组成：前面的主检结论 / 阳性结果汇总，
 * 后面按科室或检查项目分节的明细（章节标题 → 表头 → 条目 → 小结）。
 * 这里只识别这些通用版式信号，不认识任何器官，也不依赖机构模板；
 * 解剖归类在 parser.ts 中基于人体结构树完成。
 */

export interface LayoutPage { number: number; text: string }

export interface LayoutConclusion { text: string; group: string | null; page: number }

export interface LayoutItem {
  section: string
  name: string
  value: string
  flag: '↑' | '↓' | null
  refText: string | null
  abnormal: boolean
  page: number
  raw: string
}

export interface LayoutSummary { section: string; text: string; page: number }

export interface ReportLayout {
  conclusions: LayoutConclusion[]
  sections: Array<{ title: string; page: number }>
  items: LayoutItem[]
  summaries: LayoutSummary[]
  detailStartPage: number | null
}

export const RANGE_RE = /(-?\d+(?:\.\d+)?)\s*(?:--|[-~～至])\s*(-?\d+(?:\.\d+)?)/g
export const UPPER_RE = /(?:≤|<)\s*(\d+(?:\.\d+)?)/g
export const LOWER_RE = /(?:≥|>)\s*(\d+(?:\.\d+)?)/g

export function lastMatch(regex: RegExp, text: string): RegExpExecArray | null {
  regex.lastIndex = 0
  let match: RegExpExecArray | null = null
  for (let current = regex.exec(text); current; current = regex.exec(text)) match = current
  regex.lastIndex = 0
  return match
}

export function parseReference(tail: string): [number | null, number | null, string | null] {
  const range = lastMatch(RANGE_RE, tail)
  if (range) return [Number(range[1]), Number(range[2]), range[0]]
  const upper = lastMatch(UPPER_RE, tail)
  if (upper) return [null, Number(upper[1]), upper[0]]
  const lower = lastMatch(LOWER_RE, tail)
  if (lower) return [Number(lower[1]), null, lower[0]]
  return [null, null, null]
}

export function collapseDoubledCjk(value: string): string {
  return value.replace(/([㐀-鿿])\1/g, '$1')
}

/** PDF 粗体常把同一段文字叠印两次：“小结小结”“检查者检查者:张三张三”。 */
export function collapseDoubledPhrases(value: string): string {
  return value.replace(/([^\s]{2,40}?)\1/g, (match, phrase: string) => /[㐀-鿿]/.test(phrase) ? phrase : match)
}

// ---- 通用的结果措辞判定 ----------------------------------------------------

const NEGATION_RE = /^(?:双侧|双|左侧|右侧|左|右)?\s*(?:未见|未触及|未扪及|未闻及|未发现|未查见|未检出|未见明显|无明显|无)/
const NORMAL_PHRASE_RE = /(?:未见|未触及|未扪及|未闻及|未发现|未查见|未检出|无)\s*(?:明显)?\s*(?:异常|病变|占位)|^正常|正常$|正常(?:心电图|范围|声像图)|^窦性心律$|^阴性$|含量正常/
export const SKIP_RESULT_RE = /(?:自愿弃查|弃查|弃检|未查|未做|详见.{0,8}报告|详见纸质|见图文)/
const ABNORMAL_WORDS = [
  '增高', '降低', '偏高', '偏低', '减低', '升高', '异常', '阳性', '结节', '脂肪肝', '钙化', '囊肿', '增生', '积液', '炎', '糜样', '糜烂',
  '结石', '结晶', '龋', '变直', '增厚', '左偏', '右偏', '低电压', '早搏', '期前收缩', '阻滞', '肥大', '息肉', '肌瘤', '斑块', '硬化', '狭窄',
  '扩张', '痔', '疝', '贫血', '超重', '肥胖', '缺血', '待查', '肿大', '占位', '骨质疏松', '骨量减少', '突出', '膨出', '退行', '骨质增生',
  '感染', '反流', '缺失', '残根', '阻生', '萌出受阻', '副脾', '分泌物多', '偏大', '偏小', '不齐', '过速', '过缓', '减退', '偏移', '曲度',
  '血管瘤', '不全', '稀疏', 'BI-RADS', 'TI-RADS', 'Lung-RADS', '低血压', '高血压', '低密度灶', '高回声', '低回声', '强回声',
]
const MILD_RE = /(?:轻度|轻微|少许|少量|可能|倾向|考虑|趋势)/

export function hasAbnormalWord(text: string): boolean {
  return ABNORMAL_WORDS.some((word) => text.includes(word))
}

/**
 * 以分句为单位判定一段结果文字：否定开头的分句视为正常，
 * 含异常措辞的分句视为异常（轻度 / 可能 等措辞降为关注），整体取最重。
 * 无法判断返回 null。
 */
export function assessResultText(text: string): HealthStatus | null {
  const body = text.replace(/^[^:：]{1,16}[:：]\s*/, '')
  if (SKIP_RESULT_RE.test(body)) return null
  let result: HealthStatus | null = null
  const rank: Record<HealthStatus, number> = { insufficient: 0, normal: 1, attention: 2, abnormal: 3 }
  const raise = (status: HealthStatus) => { if (!result || rank[status] > rank[result]) result = status }
  for (const clause of body.split(/[，,；;。]/).map((item) => item.trim()).filter(Boolean)) {
    if (NEGATION_RE.test(clause) || NORMAL_PHRASE_RE.test(clause)) { raise('normal'); continue }
    if (hasAbnormalWord(clause)) raise(MILD_RE.test(clause) && !/(?:阳性|增高|降低|偏高|偏低|减低|升高)/.test(clause) ? 'attention' : 'abnormal')
  }
  if (!result && NORMAL_PHRASE_RE.test(body)) result = 'normal'
  // “总胆红素测定增高:26.1µmol/L”这类把结论写在标签里的情况。
  if (!result && body !== text && hasAbnormalWord(text.slice(0, text.length - body.length))) result = 'abnormal'
  return result
}

// ---- 版式信号 -------------------------------------------------------------

/** 进入明细部分的标志。 */
const DETAIL_START_RE = /^(?:第.部分\s*)?(?:分项报告|分科检查结果|健康体检结果|体检结果明细|检查结果明细|各科检查结果|详细检查结果|检查结果详情)$/
/** 表头：项目 + 结果/所见。 */
const TABLE_HEADER_RE = /^(?:检查|检验)?项目(?:名称)?\s.*(?:结果|所见)/
/** 结论部分中需要跳过的科普、说明区域。 */
const SKIP_REGION_RE = /^(?:医学科普|异常指标解读|专家建议与指导|健康指导|健康建议|健康知识|名词解释|报告阅读说明|报告导读|健康体检报告导读|免责声明|温馨提示|体检须知)/
/** 结论区域的起点，结束上面的跳过状态。 */
const CONCLUSION_START_RE = /(?:主检报告|主检结论|总检结论|总检报告|体检结论|阳性结果|异常情况|主要问题|异常结果|进一步检查|复查建议|体检小结|健康问题)/
const SUMMARY_RE = /^(?:[一-龥]{0,4})?(?:小结|初步意见|检查结论|诊断意见|结论|印象|检查结果|提示)\s*[:：]?\s*(.*)$/
const SIGNATURE_RE = /^(?:检查者|检验者|审核者|操作者|报告医师|报告医生|审核医师|主检医师|医师|医生|报告日期|检查日期|检测时间|报告时间|注[:：]|此检验结果|本检测结果|以上结果|本报告|有疑问)/
const BRACKET_HEADER_RE = /^【\s*([^】]{2,40}?)\s*】/
const DOT_HEADER_RE = /^[·•]\s*([^\s:：]{2,24})/
const NON_SECTION_RE = /^(?:\d+|备注|医学解释|常见原因|建议|注意|说明)/
const VALUE_TOKEN_RE = /^(?:[<>≤≥]?-?\d+(?:\.\d+)?(?:[-~]\d+(?:\.\d+)?)?|阴性|阳性|弱阳性|[+-]{1,4}|\d\+|\+-|[ⅠⅡⅢⅣ]+|I{1,3}|IV)(?:\(.*\))?$/i
const FLAG_TOKEN_RE = /^(?:↑|↓|H|L|偏高|偏低)$/

function sectionTitle(line: string): string | null {
  const bracket = BRACKET_HEADER_RE.exec(line)
  const raw = bracket?.[1] ?? DOT_HEADER_RE.exec(line)?.[1]
  if (!raw) return null
  const title = raw.replace(/[【】]/g, '').replace(/\s*\d+\s*$/, '').replace(/\s+/g, '').trim()
  if (title.length < 2 || NON_SECTION_RE.test(title) || /[:：]/.test(title)) return null
  return title
}

/** 在四成以上页面的首尾几行重复出现的是页眉页脚（表头、小结虽然也重复，但不在页边）。 */
function boilerplate(pages: LayoutPage[]): Set<string> {
  if (pages.length < 4) return new Set()
  const counts = new Map<string, number>()
  for (const page of pages) {
    const lines = page.text.split('\n').map((item) => item.trim()).filter(Boolean)
    const edges = new Set([...lines.slice(0, 3), ...lines.slice(-3)])
    for (const line of edges) if (!TABLE_HEADER_RE.test(line) && !SUMMARY_RE.test(line)) counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count >= Math.max(3, pages.length * 0.4)).map(([line]) => line))
}

function parseItem(section: string, line: string, page: number): LayoutItem | null {
  const tokens = line.replace(/^★\s*/, '').split(/\s+/).filter(Boolean)
  const valueIndex = tokens.findIndex((token, index) => index > 0 && VALUE_TOKEN_RE.test(token))
  if (valueIndex < 1) return null
  const nameTokens = tokens.slice(0, valueIndex)
  if (nameTokens.length > 1 && /^[A-Za-z][\w%#\-/.()]*$/.test(nameTokens.at(-1)!)) nameTokens.pop()
  const name = nameTokens.join('')
  if (!/[㐀-鿿A-Za-z]/.test(name) || name.length > 40) return null
  const value = tokens[valueIndex]!
  const rest = tokens.slice(valueIndex + 1)
  const flagToken = rest.find((token) => FLAG_TOKEN_RE.test(token))
  const flag = flagToken ? (['↑', 'H', '偏高'].includes(flagToken) ? '↑' : '↓') : null
  const tail = rest.join(' ')
  const [low, high, refText] = parseReference(tail)
  const numeric = /^[<>≤≥]?-?\d+(?:\.\d+)?$/.test(value) ? Number(value.replace(/[<>≤≥]/g, '')) : null
  let abnormal = flag !== null
  // 只信任独立成列的参考值；“≥5.0(对数视力)”这类夹在说明文字里的数字不参与比较。
  const refAt = refText ? tail.lastIndexOf(refText) : -1
  const standalone = refAt >= 0 && /^\s?$/.test(tail.charAt(refAt - 1)) && /^\s?$/.test(tail.charAt(refAt + refText!.length))
  if (!abnormal && standalone && numeric !== null && !value.match(/^[<>≤≥]/)) abnormal = (low !== null && numeric < low) || (high !== null && numeric > high)
  if (!abnormal && /^(?:阳性|弱阳性|\+{1,4}|\d\+)$/.test(value) && /阴性/.test(tail)) abnormal = true
  return { section, name, value, flag: flag ?? (abnormal && numeric !== null && high !== null && numeric > high ? '↑' : abnormal && numeric !== null ? '↓' : null),
    refText: refText ?? (/阴性/.test(tail) ? '阴性' : null), abnormal, page, raw: line }
}

export function extractLayout(pages: LayoutPage[]): ReportLayout {
  const noise = boilerplate(pages)
  const lines = pages.flatMap((page) => page.text.split('\n').map((raw) => ({ page: page.number,
    text: collapseDoubledPhrases(raw.trim().replace(/\s+/g, ' ')) })))
    .filter((line) => line.text && !noise.has(line.text) && !/^\d+\s*\/\s*\d+$/.test(line.text) && !/^第?\s*\d+\s*页/.test(line.text))

  // 明细部分：显式标题，或者“章节标题后三行内出现表头”的第一个位置。
  let detailIndex = lines.findIndex((line) => DETAIL_START_RE.test(line.text.replace(/\s+/g, '')))
  if (detailIndex < 0) {
    detailIndex = lines.findIndex((line, index) => (sectionTitle(line.text) !== null || /^[一-龥()（）]{2,16}$/.test(line.text))
      && lines.slice(index + 1, index + 4).some((next) => TABLE_HEADER_RE.test(next.text)))
  }
  const detailStartPage = detailIndex >= 0 ? lines[detailIndex]!.page : null

  const conclusions: LayoutConclusion[] = []
  let skipping = false; let group: string | null = null
  const conclusionEnd = detailIndex >= 0 ? detailIndex : lines.filter((line) => line.page <= 6).length
  for (const line of lines.slice(0, conclusionEnd)) {
    const marker = collapseDoubledCjk(line.text).replace(/\s+/g, '')
    if (SKIP_REGION_RE.test(marker)) { skipping = true; group = null; continue }
    const heading = marker.replace(/[(（][^)）]*[)）]/g, '')
    if (CONCLUSION_START_RE.test(heading) && heading.length <= 24 && !/[，。,；;]/.test(heading) && !/^\d/.test(heading)) { skipping = false; group = null; continue }
    if (skipping) continue
    const header = /^★\s*([^\d:：(（]{2,16})$/.exec(line.text)
    if (header && !hasAbnormalWord(header[1]!)) { group = header[1]!.trim(); continue }
    conclusions.push({ text: line.text, group, page: line.page })
  }

  const sections: ReportLayout['sections'] = []; const items: LayoutItem[] = []; const summaries: LayoutSummary[] = []
  if (detailIndex >= 0) {
    let section = ''; let inTable = false; let loose: { text: string; page: number } | null = null
    const detail = lines.slice(detailIndex)
    for (let index = 0; index < detail.length; index += 1) {
      const line = detail[index]!
      const title = sectionTitle(line.text)
      if (title) { section = title; inTable = false; loose = null; sections.push({ title, page: line.page }); continue }
      if (TABLE_HEADER_RE.test(line.text)) {
        // 没有显式章节标题的机构：以表头上一行作为章节名。
        const previous = detail[index - 1]?.text
        if (!section && previous && /^[一-龥()（）]{2,16}$/.test(previous)) { section = previous; sections.push({ title: section, page: line.page }) }
        inTable = true; continue
      }
      const summary = SUMMARY_RE.exec(line.text)
      if (summary && section) {
        const parts: string[] = []
        if (summary[1]) parts.push(summary[1])
        else if (loose) parts.push(loose.text)
        for (let next = index + 1; next < detail.length && parts.length < 6; next += 1) {
          const text = detail[next]!.text
          if (sectionTitle(text) || TABLE_HEADER_RE.test(text) || SUMMARY_RE.test(text) || SIGNATURE_RE.test(text)) break
          if (parseItem(section, text, line.page) && !/[:：]/.test(text)) break
          parts.push(text); index = next
        }
        for (const part of parts) summaries.push({ section, text: part, page: line.page })
        loose = null; inTable = false; continue
      }
      if (SIGNATURE_RE.test(line.text)) { loose = null; continue }
      const item = section && inTable ? parseItem(section, line.text, line.page) : null
      if (item) { items.push(item); loose = null; continue }
      loose = /\s/.test(line.text) ? null : { text: line.text, page: line.page }
    }
  }
  return { conclusions, sections, items, summaries, detailStartPage }
}
