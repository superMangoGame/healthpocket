import type { LocalDatabase } from './database.ts'

/**
 * Rule-based insights for the daily health page. They join three sources the
 * dashboard otherwise shows apart - the latest checkup report, Garmin sleep and
 * recovery, and training - and turn each pattern into one concrete suggestion.
 * Thresholds follow common public guidance (WHO activity, adult sleep duration,
 * Chinese BMI bands); they describe lifestyle, never diagnose.
 */

export type InsightLevel = 'good' | 'attention' | 'important'
export type InsightCategory = 'body_age' | 'sleep' | 'activity' | 'recovery' | 'report'

export interface DailyInsight {
  id: string
  category: InsightCategory
  level: InsightLevel
  title: string
  /** What the data shows, with numbers and dates. */
  finding: string
  /** What to do about it. */
  advice: string
  sources: string[]
}

export interface FitnessAgeComponent {
  key: 'rhr' | 'vigorous_minutes' | 'vigorous_days' | 'bmi' | 'body_fat'
  label: string
  value: number
  unit: string
  target: string
  on_target: boolean
  advice: string
}

export interface FitnessAge {
  date: string
  fitness_age: number
  chronological_age: number | null
  achievable_fitness_age: number | null
  previous_fitness_age: number | null
  components: FitnessAgeComponent[]
}

export interface DailyInsights {
  range: { from: string; to: string }
  fitness_age: FitnessAge | null
  insights: DailyInsight[]
  /** Compact numbers behind the insights, also handed to the AI advice prompt. */
  context: Record<string, unknown>
}

type DailyRow = {
  date: string; steps: number | null; resting_hr: number | null; average_stress: number | null; body_battery_high: number | null
  intensity_minutes: number | null; sleep_seconds: number | null; deep_sleep_seconds: number | null; rem_sleep_seconds: number | null
  sleep_score: number | null; hrv_last_night: number | null
}
type ActivityRow = { date: string; type: string; duration_seconds: number; training_effect: number | null }
type MeasurementRow = {
  canonical_id: string; raw_name: string; value_numeric: number | null; value_text: string | null; unit: string | null
  ref_low: number | null; ref_high: number | null; flag: string | null; status: string
}
type ReportRow = { id: string; exam_date: string | null; year: number | null }

const DAILY_SQL = `SELECT date,steps,resting_hr,average_stress,body_battery_high,intensity_minutes,sleep_seconds,deep_sleep_seconds,rem_sleep_seconds,sleep_score,hrv_last_night
  FROM garmin_daily WHERE profile_id=:profile AND date BETWEEN :from AND :to ORDER BY date`
const BASELINE_DAYS = 28
const STRENGTH_TYPES = /strength|weight_training/i

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null
}
function round(value: number, digits = 0): number { const scale = 10 ** digits; return Math.round(value * scale) / scale }
function shiftDay(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10)
}
function daysBetween(from: string, to: string): number { return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1 }
function hours(seconds: number): string { return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分` }
function num(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** Reads Garmin's fitness-age snapshot (/fitnessage-service) and explains each factor against its target. */
export function fitnessAgeFromRaw(date: string, raw: unknown): FitnessAge | null {
  const data = obj(raw)
  const fitnessAge = num(data.fitnessAge)
  if (fitnessAge === null) return null
  const parts = obj(data.components)
  const value = (key: string) => num(obj(parts[key]).value)
  const components: FitnessAgeComponent[] = []
  const rhr = value('rhr')
  if (rhr !== null) components.push({ key: 'rhr', label: '静息心率', value: rhr, unit: '次/分', target: '≤ 60', on_target: rhr <= 60,
    advice: rhr <= 60 ? '静息心率处于较好水平，保持规律有氧训练即可。' : '每周 3–5 次 30 分钟以上的中低强度有氧（慢跑、骑行、游泳），并保证睡眠，静息心率通常会在数周内下降。' })
  const minutes = value('vigorousMinutesAvg')
  if (minutes !== null) components.push({ key: 'vigorous_minutes', label: '每周高强度分钟', value: round(minutes), unit: '分钟', target: '≥ 150', on_target: minutes >= 150,
    advice: minutes >= 150 ? '高强度运动量已达标，注意安排恢复日。' : `比目标少约 ${round(150 - minutes)} 分钟：在已有训练中加入间歇（如 4×4 分钟快跑/快骑），或把一次轻松跑换成节奏跑。` })
  const days = value('vigorousDaysAvg')
  if (days !== null) components.push({ key: 'vigorous_days', label: '每周高强度天数', value: round(days, 1), unit: '天', target: '≥ 3', on_target: days >= 3,
    advice: days >= 3 ? '高强度训练分布均匀。' : '把高强度训练分散到每周至少 3 天，比集中在 1–2 天更有利于心肺适能，也更好恢复。' })
  const bmi = value('bmi')
  if (bmi !== null) components.push({ key: 'bmi', label: 'BMI', value: round(bmi, 1), unit: '', target: '18.5–23.9', on_target: bmi >= 18.5 && bmi < 24,
    advice: bmi < 18.5 ? 'BMI 偏低，适当增加蛋白质和力量训练以增加肌肉量。' : bmi < 24 ? 'BMI 在理想范围内，保持现有饮食与运动。' : '控制总热量、减少精制碳水和含糖饮料，配合力量训练，每月减重 1–2 kg 较稳妥。' })
  const fat = value('bodyFat')
  if (fat !== null) components.push({ key: 'body_fat', label: '体脂率', value: round(fat, 1), unit: '%', target: '男 < 20 / 女 < 28', on_target: fat < 25,
    advice: '体脂率主要靠力量训练 + 适度热量缺口改善，每周 2–3 次全身力量训练。' })
  return {
    date,
    fitness_age: round(fitnessAge, 1),
    chronological_age: num(data.chronologicalAge),
    achievable_fitness_age: num(data.achievableFitnessAge) === null ? null : round(num(data.achievableFitnessAge)!, 1),
    previous_fitness_age: num(data.previousFitnessAge) === null ? null : round(num(data.previousFitnessAge)!, 1),
    components,
  }
}

function latestFitnessAge(db: LocalDatabase, profile: string, to: string): FitnessAge | null {
  const row = db.one<{ date: string; raw_json: string }>(`SELECT date,raw_json FROM garmin_daily
    WHERE profile_id=:profile AND date<=:to AND instr(raw_json,'"fitness_age":{')>0 ORDER BY date DESC LIMIT 1`, { profile, to })
  if (!row) return null
  try { return fitnessAgeFromRaw(row.date, (JSON.parse(row.raw_json) as Record<string, unknown>).fitness_age) } catch { return null }
}

function direction(row: MeasurementRow): 'high' | 'low' | null {
  const flag = (row.flag ?? '').toUpperCase()
  if (flag.includes('H') || flag.includes('↑')) return 'high'
  if (flag.includes('L') || flag.includes('↓')) return 'low'
  if (row.value_numeric === null) return null
  if (row.ref_high !== null && row.value_numeric > row.ref_high) return 'high'
  if (row.ref_low !== null && row.value_numeric < row.ref_low) return 'low'
  return null
}

function measurementText(row: MeasurementRow): string {
  const value = row.value_numeric !== null ? `${row.value_numeric}${row.unit ? ` ${row.unit}` : ''}` : row.value_text ?? ''
  const ref = row.ref_low !== null && row.ref_high !== null ? `（参考 ${row.ref_low}–${row.ref_high}）`
    : row.ref_high !== null ? `（参考 ≤ ${row.ref_high}）` : row.ref_low !== null ? `（参考 ≥ ${row.ref_low}）` : ''
  return `${row.raw_name} ${value}${ref}`.trim()
}

export function buildDailyInsights(db: LocalDatabase, profile: string, range: { from: string; to: string }): DailyInsights {
  const { from, to } = range
  const days = db.rows<DailyRow>(DAILY_SQL, { profile, from, to })
  const baseline = db.rows<DailyRow>(DAILY_SQL, { profile, from: shiftDay(from, -BASELINE_DAYS), to: shiftDay(from, -1) })
  const activities = db.rows<ActivityRow>('SELECT date,type,duration_seconds,training_effect FROM garmin_activities WHERE profile_id=:profile AND date BETWEEN :from AND :to', { profile, from, to })
  const report = db.one<ReportRow>(`SELECT id,exam_date,year FROM reports WHERE profile_id=:profile AND parse_status='completed'
    ORDER BY COALESCE(exam_date, year || '-12-31') DESC LIMIT 1`, { profile })
  const abnormal = report ? db.rows<MeasurementRow>(`SELECT canonical_id,raw_name,value_numeric,value_text,unit,ref_low,ref_high,flag,status FROM measurements
    WHERE report_id=:report AND status IN ('abnormal','attention')`, { report: report.id }) : []
  const reportFindings = report ? db.rows<{ title: string }>(`SELECT DISTINCT title FROM findings WHERE report_id=:report AND severity='abnormal' LIMIT 12`, { report: report.id }) : []
  const reportLabel = report ? `体检 ${report.exam_date ?? report.year ?? ''}`.trim() : '体检'
  const fitness = latestFitnessAge(db, profile, to)

  const span = Math.max(1, daysBetween(from, to))
  const sleepAvg = mean(days.map((row) => row.sleep_seconds))
  const deepShare = mean(days.map((row) => row.sleep_seconds && row.deep_sleep_seconds !== null ? row.deep_sleep_seconds / row.sleep_seconds : null))
  const sleepScore = mean(days.map((row) => row.sleep_score))
  const shortNights = days.filter((row) => row.sleep_seconds !== null && row.sleep_seconds < 6 * 3600).length
  const sleepNights = days.filter((row) => row.sleep_seconds !== null).length
  const intensityDays = days.filter((row) => row.intensity_minutes !== null)
  const weeklyIntensity = intensityDays.length >= 3 ? intensityDays.reduce((sum, row) => sum + (row.intensity_minutes ?? 0), 0) / intensityDays.length * 7 : null
  const steps = mean(days.map((row) => row.steps))
  const rhr = mean(days.map((row) => row.resting_hr)); const rhrBase = mean(baseline.map((row) => row.resting_hr))
  const hrv = mean(days.map((row) => row.hrv_last_night)); const hrvBase = mean(baseline.map((row) => row.hrv_last_night))
  const stress = mean(days.map((row) => row.average_stress))
  const battery = mean(days.map((row) => row.body_battery_high))
  const strength = activities.filter((item) => STRENGTH_TYPES.test(item.type))
  const activityMinutes = activities.reduce((sum, item) => sum + (item.duration_seconds ?? 0), 0) / 60

  const insights: DailyInsight[] = []
  const add = (insight: DailyInsight) => insights.push(insight)
  const find = (...ids: string[]) => abnormal.filter((row) => ids.includes(row.canonical_id))

  // --- Body age ---------------------------------------------------------
  if (fitness) {
    const gap = fitness.chronological_age !== null ? round(fitness.chronological_age - fitness.fitness_age, 1) : null
    const weak = fitness.components.filter((item) => !item.on_target)
    add({ id: 'body-age', category: 'body_age', level: weak.length ? 'attention' : 'good', title: '身体年龄',
      finding: `Garmin 估算身体年龄 ${fitness.fitness_age} 岁${gap !== null ? `，${gap >= 0 ? `比实际年龄年轻 ${gap} 岁` : `比实际年龄大 ${-gap} 岁`}` : ''}${fitness.previous_fitness_age !== null ? `（上次 ${fitness.previous_fitness_age} 岁）` : ''}。`,
      advice: weak.length ? `优先改善：${weak.map((item) => `${item.label}（${item.value}${item.unit}，目标 ${item.target}）`).join('、')}。${weak[0]!.advice}` : '各项因素都在目标范围内，保持当前训练与作息即可。',
      sources: ['Garmin 身体年龄'] })
  }

  // --- Sleep ------------------------------------------------------------
  if (sleepAvg !== null && sleepNights >= 3) {
    const short = sleepAvg < 7 * 3600
    const recoveryHint = hrv !== null && hrvBase !== null && hrv < hrvBase * 0.92 ? '，同期 HRV 低于自己的基线，恢复可能受到影响' : ''
    add({ id: 'sleep-duration', category: 'sleep', level: sleepAvg < 6 * 3600 ? 'important' : short ? 'attention' : 'good', title: short ? '睡眠时长不足' : '睡眠时长充足',
      finding: `${sleepNights} 晚平均睡眠 ${hours(sleepAvg)}${shortNights ? `，其中 ${shortNights} 晚不足 6 小时` : ''}${sleepScore !== null ? `，平均睡眠分数 ${round(sleepScore)}` : ''}${recoveryHint}。`,
      advice: short ? '成年人建议每晚 7–9 小时。固定起床时间、把入睡时间提前 30 分钟，睡前 1 小时远离屏幕和高强度训练。' : '保持规律作息；高强度训练日可再多睡 30 分钟帮助恢复。',
      sources: ['睡眠'] })
  }
  if (deepShare !== null && sleepNights >= 5 && deepShare < 0.13) {
    add({ id: 'sleep-deep', category: 'sleep', level: 'attention', title: '深睡比例偏低',
      finding: `深睡平均占总睡眠的 ${round(deepShare * 100)}%，低于常见的 13–23%。`,
      advice: '晚饭后避免酒精和咖啡因，卧室保持凉爽黑暗；把高强度训练安排在睡前 3 小时以前。',
      sources: ['睡眠'] })
  }

  // --- Activity ---------------------------------------------------------
  if (weeklyIntensity !== null) {
    const enough = weeklyIntensity >= 150
    add({ id: 'activity-intensity', category: 'activity', level: enough ? 'good' : weeklyIntensity < 75 ? 'important' : 'attention', title: enough ? '运动量达标' : '中高强度运动不足',
      finding: `折合每周约 ${round(weeklyIntensity)} 强度分钟（高强度按 2 倍计），${label(span)}共 ${activities.length} 次运动、${round(activityMinutes)} 分钟${steps !== null ? `，日均 ${round(steps)} 步` : ''}。`,
      advice: enough ? `已达到 WHO 每周 150 分钟的建议${weeklyIntensity > 450 ? '，量已较大，注意每周至少 1–2 个完整休息日' : '，可继续保持'}。` : `距每周 150 分钟还差约 ${round(150 - weeklyIntensity)} 分钟，可从每天 20–30 分钟快走或骑行开始。`,
      sources: ['运动'] })
  }
  if (span >= 14 && activities.length >= 3 && strength.length === 0) {
    add({ id: 'activity-strength', category: 'activity', level: 'attention', title: '缺少力量训练',
      finding: `${label(span)}的 ${activities.length} 次运动中没有力量训练记录。`,
      advice: '每周加入 2 次全身力量训练（深蹲、硬拉/臀桥、俯卧撑、划船），每次 20–30 分钟，对代谢、骨密度和受伤预防都有帮助。',
      sources: ['运动'] })
  }

  // --- Recovery ---------------------------------------------------------
  if (rhr !== null && rhrBase !== null && rhr - rhrBase >= 3) {
    add({ id: 'recovery-rhr', category: 'recovery', level: 'attention', title: '静息心率上升',
      finding: `静息心率均值 ${round(rhr)} 次/分，比之前 ${BASELINE_DAYS} 天（${round(rhrBase)}）高 ${round(rhr - rhrBase)}。`,
      advice: '可能与疲劳累积、睡眠不足、饮酒或身体不适有关。接下来几天降低训练强度、优先睡眠；若持续升高并伴随不适，请就医。',
      sources: ['心率'] })
  }
  if (hrv !== null && hrvBase !== null && hrv < hrvBase * 0.9) {
    add({ id: 'recovery-hrv', category: 'recovery', level: 'attention', title: 'HRV 低于个人基线',
      finding: `夜间 HRV 均值 ${round(hrv)} ms，比之前 ${BASELINE_DAYS} 天（${round(hrvBase)} ms）低 ${round((1 - hrv / hrvBase) * 100)}%。`,
      advice: '身体恢复不足的信号。把下一次高强度训练改为轻松有氧或休息，并检查睡眠与压力。',
      sources: ['HRV'] })
  }
  if (stress !== null && stress >= 35) {
    add({ id: 'recovery-stress', category: 'recovery', level: stress >= 50 ? 'important' : 'attention', title: '日间压力偏高',
      finding: `平均压力值 ${round(stress)}${battery !== null ? `，身体电量最高值平均 ${round(battery)}` : ''}。`,
      advice: '每天安排 2–3 次 3 分钟的缓慢呼吸（吸 4 秒、呼 6 秒），午后减少咖啡因；身体电量早晨低于 50 时，当天以轻松活动为主。',
      sources: ['压力'] })
  }

  // --- Checkup report × lifestyle --------------------------------------
  const intensityText = weeklyIntensity !== null ? `近期每周约 ${round(weeklyIntensity)} 强度分钟` : '近期运动数据不足'
  const lipids = find('total_cholesterol', 'ldl', 'triglyceride').filter((row) => direction(row) === 'high')
  const lowHdl = find('hdl').filter((row) => direction(row) === 'low')
  if (lipids.length || lowHdl.length) {
    add({ id: 'report-lipids', category: 'report', level: 'important', title: '血脂异常 × 运动',
      finding: `${reportLabel}：${[...lipids, ...lowHdl].map(measurementText).join('；')}。${intensityText}。`,
      advice: `规律有氧（每周 150–300 分钟）配合力量训练能降低甘油三酯、提升高密度脂蛋白；饮食上减少肥肉、油炸和动物内脏，增加燕麦、豆类和深海鱼。${weeklyIntensity !== null && weeklyIntensity >= 150 ? '运动量已足够，重点放在饮食调整。' : ''}建议 3–6 个月后复查血脂。`,
      sources: [reportLabel, '运动'] })
  }
  const glucose = find('glucose').filter((row) => direction(row) === 'high')
  if (glucose.length) {
    add({ id: 'report-glucose', category: 'report', level: 'important', title: '血糖偏高 × 日常活动',
      finding: `${reportLabel}：${glucose.map(measurementText).join('；')}。${steps !== null ? `日均 ${round(steps)} 步。` : ''}`,
      advice: '餐后 10–15 分钟快走 15 分钟能明显降低餐后血糖；减少含糖饮料和精米白面，并保证 7 小时以上睡眠（睡眠不足会升高血糖）。请遵医嘱复查空腹血糖和糖化血红蛋白。',
      sources: [reportLabel, '步数', '睡眠'] })
  }
  const uric = find('uric_acid').filter((row) => direction(row) === 'high')
  if (uric.length) {
    add({ id: 'report-uric', category: 'report', level: 'attention', title: '尿酸偏高 × 训练补水',
      finding: `${reportLabel}：${uric.map(measurementText).join('；')}。${intensityText}。`,
      advice: '每天饮水 2 L 以上，长时间或高强度训练前后额外补水；少喝啤酒、含果糖饮料，控制海鲜和浓肉汤。',
      sources: [reportLabel, '运动'] })
  }
  const liver = find('alt', 'ast', 'ggt').filter((row) => direction(row) === 'high')
  if (liver.length) {
    add({ id: 'report-liver', category: 'report', level: 'attention', title: '肝功能指标偏高',
      finding: `${reportLabel}：${liver.map(measurementText).join('；')}。`,
      advice: '戒酒或严格限酒，控制体重与精制碳水；剧烈运动后 48 小时内 AST 也可能短暂升高，复查前 2 天避免高强度训练。',
      sources: [reportLabel] })
  }
  const bpHigh = find('systolic_bp', 'diastolic_bp').filter((row) => direction(row) === 'high')
  const bpLow = find('systolic_bp', 'diastolic_bp').filter((row) => direction(row) === 'low')
  if (bpHigh.length) {
    add({ id: 'report-bp-high', category: 'report', level: 'important', title: '血压偏高 × 睡眠与压力',
      finding: `${reportLabel}：${bpHigh.map(measurementText).join('；')}。${sleepAvg !== null ? `平均睡眠 ${hours(sleepAvg)}` : ''}${stress !== null ? `，平均压力 ${round(stress)}` : ''}。`,
      advice: '每天盐摄入控制在 5 g 以内，规律有氧运动、保证睡眠并管理压力都能降低血压；建议在家定时测量并记录。',
      sources: [reportLabel, '睡眠', '压力'] })
  } else if (bpLow.length) {
    add({ id: 'report-bp-low', category: 'report', level: 'attention', title: '血压偏低 × 训练',
      finding: `${reportLabel}：${bpLow.map(measurementText).join('；')}。${rhr !== null ? `静息心率 ${round(rhr)} 次/分` : ''}${weeklyIntensity !== null ? `，${intensityText}` : ''}。`,
      advice: '经常运动的人血压和心率偏低较常见。训练后注意补水和电解质，从坐卧位起身放慢速度；如出现头晕、黑朦或乏力，请就医评估。',
      sources: [reportLabel, '心率', '运动'] })
  }
  const bilirubin = find('total_bilirubin', 'direct_bilirubin').filter((row) => direction(row) === 'high')
  if (bilirubin.length && !liver.length) {
    add({ id: 'report-bilirubin', category: 'report', level: 'attention', title: '胆红素偏高 × 训练与空腹',
      finding: `${reportLabel}：${bilirubin.map(measurementText).join('；')}。${intensityText}。`,
      advice: '单纯胆红素轻度升高常与空腹时间过长、剧烈运动、熬夜或体质（如 Gilbert 综合征）有关。复查前 2–3 天避免高强度训练、保证睡眠、不要长时间空腹；若伴随皮肤或眼白发黄、乏力，请尽快就医。',
      sources: [reportLabel, '运动', '睡眠'] })
  }
  const anemia = find('hemoglobin', 'rbc').filter((row) => direction(row) === 'low')
  if (anemia.length) {
    add({ id: 'report-hemoglobin', category: 'report', level: 'attention', title: '血红蛋白偏低 × 耐力',
      finding: `${reportLabel}：${anemia.map(measurementText).join('；')}。`,
      advice: '血红蛋白偏低会降低耐力表现、让心率更容易升高。多吃红肉、动物肝脏和深绿色蔬菜，搭配维生素 C；建议咨询医生是否需要查铁蛋白。',
      sources: [reportLabel] })
  }
  const bmi = find('bmi').filter((row) => direction(row) === 'high')
  if (bmi.length && !fitness?.components.some((item) => item.key === 'bmi')) {
    add({ id: 'report-bmi', category: 'report', level: 'attention', title: '体重指数偏高',
      finding: `${reportLabel}：${bmi.map(measurementText).join('；')}。${intensityText}。`,
      advice: '每天约 300–500 kcal 的热量缺口加每周 2–3 次力量训练，比单纯节食更能保住肌肉。',
      sources: [reportLabel, '运动'] })
  }

  // Conclusions repeat across report sections, sometimes cut off ("…(TI"): drop the
  // section prefix and any copy contained in a longer one.
  const conclusions = reportFindings.map((row) => row.title).filter((title) => !/偏高|偏低|增高|减低|升高|降低|测定/.test(title))
    .map((title) => title.replace(/^[^:：]{1,12}[:：]/, '').replace(/\([^)]*$/, '').trim()).filter(Boolean)
  const followUps = [...new Set(conclusions)].filter((title, _, all) => !all.some((other) => other !== title && other.includes(title)))
  if (followUps.length) {
    add({ id: 'report-follow-up', category: 'report', level: 'attention', title: '体检随访提醒',
      finding: `${reportLabel}有 ${followUps.length} 项影像或检查结论需要关注：${followUps.slice(0, 4).join('；')}${followUps.length > 4 ? ' 等' : ''}。`,
      advice: '这类发现需要医生结合影像判断，请按报告或医生建议的时间复查，并把这次报告带上做对比。',
      sources: [reportLabel] })
  }

  const order: Record<InsightLevel, number> = { important: 0, attention: 1, good: 2 }
  insights.sort((a, b) => (a.category === 'body_age' ? -1 : 0) - (b.category === 'body_age' ? -1 : 0) || order[a.level] - order[b.level])

  return {
    range, fitness_age: fitness, insights,
    context: {
      range, days_with_data: days.length,
      sleep: { avg_hours: sleepAvg === null ? null : round(sleepAvg / 3600, 1), deep_share_pct: deepShare === null ? null : round(deepShare * 100), avg_score: sleepScore === null ? null : round(sleepScore), nights_under_6h: shortNights, nights: sleepNights },
      activity: { weekly_intensity_minutes: weeklyIntensity === null ? null : round(weeklyIntensity), sessions: activities.length, total_minutes: round(activityMinutes), strength_sessions: strength.length, avg_steps: steps === null ? null : round(steps),
        by_type: Object.entries(activities.reduce<Record<string, number>>((acc, item) => { acc[item.type] = (acc[item.type] ?? 0) + 1; return acc }, {})).map(([type, count]) => ({ type, count })) },
      recovery: { resting_hr: rhr === null ? null : round(rhr), resting_hr_baseline: rhrBase === null ? null : round(rhrBase), hrv_ms: hrv === null ? null : round(hrv), hrv_baseline_ms: hrvBase === null ? null : round(hrvBase), avg_stress: stress === null ? null : round(stress), body_battery_high: battery === null ? null : round(battery) },
      fitness_age: fitness,
      latest_report: report ? { date: report.exam_date ?? report.year, findings: reportFindings.map((row) => row.title), abnormal: abnormal.map((row) => ({ item: row.raw_name, value: row.value_numeric ?? row.value_text, unit: row.unit, ref_low: row.ref_low, ref_high: row.ref_high, direction: direction(row), status: row.status })) } : null,
    },
  }
}

function label(span: number): string { return span <= 7 ? '近 7 天' : `这 ${span} 天` }
