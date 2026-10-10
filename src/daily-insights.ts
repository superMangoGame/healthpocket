import type { LocalDatabase } from './database.ts'

/**
 * Rule-based insights for the daily health page, built from Garmin data alone:
 * sleep, training, recovery and body age. Checkup reports are analysed on the
 * overview page; keeping the sources apart stops the two pages from advising
 * differently on the same number. Thresholds follow common public guidance (WHO
 * activity, adult sleep duration); they describe lifestyle, never diagnose.
 */

export type InsightLevel = 'good' | 'attention' | 'important'
export type InsightCategory = 'body_age' | 'sleep' | 'activity' | 'recovery'

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

export function buildDailyInsights(db: LocalDatabase, profile: string, range: { from: string; to: string }): DailyInsights {
  const { from, to } = range
  const days = db.rows<DailyRow>(DAILY_SQL, { profile, from, to })
  const baseline = db.rows<DailyRow>(DAILY_SQL, { profile, from: shiftDay(from, -BASELINE_DAYS), to: shiftDay(from, -1) })
  const activities = db.rows<ActivityRow>('SELECT date,type,duration_seconds,training_effect FROM garmin_activities WHERE profile_id=:profile AND date BETWEEN :from AND :to', { profile, from, to })
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
    },
  }
}

function label(span: number): string { return span <= 7 ? '近 7 天' : `这 ${span} 天` }
