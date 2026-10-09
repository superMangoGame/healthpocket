import type { LocalDatabase } from './database.ts'

/**
 * Read-only views of the stored Garmin history, shaped for the AI chat: a
 * compact overview that rides along with every question, and the two queries
 * the model can call as tools when it needs a specific range.
 *
 * Everything is aggregated on this side. A year of daily rows is ~365 × 20
 * numbers - fine for a table, wasteful as model input - so long ranges come
 * back as weekly or monthly averages unless the model asks for days.
 */

export const GARMIN_METRICS = {
  steps: '步数',
  distance_km: '距离（公里）',
  active_calories: '活动消耗（千卡）',
  resting_hr: '静息心率（次/分）',
  average_stress: '平均压力（0-100）',
  body_battery_high: '身体电量最高值',
  body_battery_low: '身体电量最低值',
  spo2_avg: '平均血氧（%）',
  respiration_avg: '清醒时平均呼吸（次/分）',
  intensity_minutes: '强度活动分钟（高强度 × 2）',
  sleep_hours: '睡眠时长（小时）',
  deep_sleep_hours: '深睡（小时）',
  rem_sleep_hours: 'REM 睡眠（小时）',
  sleep_score: '睡眠分数（0-100）',
  hrv_last_night: '夜间 HRV 均值（毫秒）',
  hrv_weekly_avg: 'HRV 7 日均值（毫秒）',
  training_readiness: '训练准备度（0-100）',
  vo2_max: '最大摄氧量',
  fitness_age: '体能年龄',
} as const

export type GarminMetric = keyof typeof GARMIN_METRICS
export type Granularity = 'day' | 'week' | 'month'

/** Days above which a range defaults to weekly, then monthly, points. */
const WEEKLY_AFTER_DAYS = 62
const MONTHLY_AFTER_DAYS = 400
/** The most points one tool answer may carry. */
const MAX_POINTS = 200
const MAX_ACTIVITIES = 120

const COLUMN: Record<GarminMetric, string> = {
  steps: 'steps', distance_km: 'distance_m / 1000.0', active_calories: 'active_calories', resting_hr: 'resting_hr',
  average_stress: 'average_stress', body_battery_high: 'body_battery_high', body_battery_low: 'body_battery_low',
  spo2_avg: 'spo2_avg', respiration_avg: 'respiration_avg', intensity_minutes: 'intensity_minutes',
  sleep_hours: 'sleep_seconds / 3600.0', deep_sleep_hours: 'deep_sleep_seconds / 3600.0', rem_sleep_hours: 'rem_sleep_seconds / 3600.0',
  sleep_score: 'sleep_score', hrv_last_night: 'hrv_last_night', hrv_weekly_avg: 'hrv_weekly_avg',
  training_readiness: 'training_readiness', vo2_max: 'vo2_max', fitness_age: 'fitness_age',
}
const OVERVIEW_METRICS: GarminMetric[] = ['sleep_score', 'sleep_hours', 'hrv_last_night', 'resting_hr', 'average_stress', 'steps', 'intensity_minutes', 'body_battery_high']

type Row = Record<string, number | string | null> & { date: string }

export class GarminQuery {
  constructor(private db: LocalDatabase) {}

  /** What is stored at all; the model needs this to know which dates it may ask about. */
  coverage(profileId: string): { first_date: string | null; last_date: string | null; days: number; activities: number } {
    const days = this.db.one<{ first_date: string | null; last_date: string | null; days: number }>('SELECT MIN(date) AS first_date,MAX(date) AS last_date,COUNT(*) AS days FROM garmin_daily WHERE profile_id=:profile', { profile: profileId })
    const activities = this.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM garmin_activities WHERE profile_id=:profile', { profile: profileId })
    return { first_date: days?.first_date ?? null, last_date: days?.last_date ?? null, days: Number(days?.days ?? 0), activities: Number(activities?.count ?? 0) }
  }

  /**
   * The summary sent with every chat question: coverage, the last two weeks day
   * by day, and monthly averages for the last year (or for the range the page is
   * showing). Small enough to include unconditionally, so a model without tool
   * support can still answer most questions.
   */
  overview(profileId: string, focus?: { from: string; to: string }): Record<string, unknown> | null {
    const coverage = this.coverage(profileId)
    if (!coverage.days || !coverage.last_date) return null
    const recentFrom = shiftDay(coverage.last_date, -13)
    const trendTo = focus?.to ?? coverage.last_date
    const trendFrom = focus?.from ?? shiftDay(trendTo, -364)
    return {
      coverage,
      metric_names: GARMIN_METRICS,
      ...(focus ? { page_range: focus } : {}),
      recent_days: this.daily(profileId, { from: recentFrom, to: coverage.last_date, metrics: OVERVIEW_METRICS, granularity: 'day' }).points,
      trend: this.daily(profileId, { from: trendFrom, to: trendTo, metrics: OVERVIEW_METRICS, granularity: daysBetween(trendFrom, trendTo) > 92 ? 'month' : 'week' }),
      activities: this.activities(profileId, { from: trendFrom, to: trendTo, limit: 0 }).summary,
    }
  }

  /** Daily metrics for a range, averaged per week or month when the range is long. */
  daily(profileId: string, input: { from: string; to: string; metrics?: GarminMetric[]; granularity?: Granularity }): { from: string; to: string; granularity: Granularity; points: Row[]; note?: string } {
    const { from, to } = orderedRange(input.from, input.to)
    const metrics = (input.metrics?.length ? input.metrics : OVERVIEW_METRICS).filter((metric) => metric in COLUMN)
    const span = daysBetween(from, to)
    let granularity: Granularity = input.granularity ?? (span > MONTHLY_AFTER_DAYS ? 'month' : span > WEEKLY_AFTER_DAYS ? 'week' : 'day')
    if (granularity === 'day' && span > MAX_POINTS) granularity = 'week'
    if (granularity === 'week' && span / 7 > MAX_POINTS) granularity = 'month'
    const rows = this.db.rows<Row>(`SELECT date,${metrics.map((metric) => `${COLUMN[metric]} AS ${metric}`).join(',')} FROM garmin_daily WHERE profile_id=:profile AND date BETWEEN :from AND :to ORDER BY date`,
      { profile: profileId, from, to })
    const points = granularity === 'day'
      ? rows.map((row) => roundRow(row, metrics))
      : aggregate(rows, metrics, granularity)
    const note = granularity !== (input.granularity ?? granularity) ? `范围较长，已改为按${granularity === 'week' ? '周' : '月'}平均` : undefined
    return { from, to, granularity, points, ...(note ? { note } : {}) }
  }

  /** Workouts in a range, newest first, with per-type totals. */
  activities(profileId: string, input: { from: string; to: string; type?: string; limit?: number }): { from: string; to: string; summary: Record<string, unknown>; items: Array<Record<string, unknown>>; truncated: boolean } {
    const { from, to } = orderedRange(input.from, input.to)
    const rows = this.db.rows<{ date: string; type: string; name: string; duration_seconds: number; distance_m: number | null; calories: number | null; average_hr: number | null; max_hr: number | null; training_effect: number | null }>(
      `SELECT date,type,name,duration_seconds,distance_m,calories,average_hr,max_hr,training_effect FROM garmin_activities
       WHERE profile_id=:profile AND date BETWEEN :from AND :to${input.type ? ' AND type=:type' : ''} ORDER BY date DESC`,
      { profile: profileId, from, to, ...(input.type ? { type: input.type } : {}) })
    const byType = new Map<string, { count: number; minutes: number; distance_km: number }>()
    for (const row of rows) {
      const entry = byType.get(row.type) ?? { count: 0, minutes: 0, distance_km: 0 }
      entry.count++; entry.minutes += row.duration_seconds / 60; entry.distance_km += (row.distance_m ?? 0) / 1000
      byType.set(row.type, entry)
    }
    const limit = Math.min(input.limit ?? MAX_ACTIVITIES, MAX_ACTIVITIES)
    return {
      from, to,
      summary: {
        count: rows.length,
        total_minutes: Math.round(rows.reduce((sum, row) => sum + row.duration_seconds / 60, 0)),
        active_days: new Set(rows.map((row) => row.date)).size,
        by_type: Object.fromEntries([...byType].sort((a, b) => b[1].minutes - a[1].minutes)
          .map(([type, entry]) => [type, { count: entry.count, minutes: Math.round(entry.minutes), distance_km: round(entry.distance_km) }])),
      },
      items: rows.slice(0, limit).map((row) => ({
        date: row.date, type: row.type, name: row.name, minutes: Math.round(row.duration_seconds / 60),
        distance_km: row.distance_m === null ? null : round(row.distance_m / 1000), calories: row.calories === null ? null : Math.round(row.calories),
        average_hr: row.average_hr, max_hr: row.max_hr, training_effect: row.training_effect,
      })),
      truncated: rows.length > limit,
    }
  }
}

function aggregate(rows: Row[], metrics: GarminMetric[], granularity: 'week' | 'month'): Row[] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = granularity === 'month' ? row.date.slice(0, 7) : weekStart(row.date)
    const group = groups.get(key) ?? []
    group.push(row); groups.set(key, group)
  }
  return [...groups].map(([key, group]) => {
    const point: Row = { date: key, days: group.length }
    for (const metric of metrics) {
      const values = group.map((row) => row[metric]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      point[metric] = values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
    }
    return point
  })
}

function roundRow(row: Row, metrics: GarminMetric[]): Row {
  const point: Row = { date: row.date }
  for (const metric of metrics) { const value = row[metric]; point[metric] = typeof value === 'number' ? round(value) : value ?? null }
  return point
}

function round(value: number): number { return Math.round(value * 10) / 10 }
function orderedRange(from: string, to: string): { from: string; to: string } { return from <= to ? { from, to } : { from: to, to: from } }
function shiftDay(date: string, offset: number): string { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + offset); return localDate(value) }
function daysBetween(from: string, to: string): number { return Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000) + 1 }
function weekStart(date: string): string { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); return localDate(value) }
function localDate(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` }
