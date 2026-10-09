import type { GarminActivity, GarminDailyPoint } from './types';

export const activityLabels: Record<string, string> = { running: '跑步', cycling: '骑行', walking: '步行', hiking: '徒步', swimming: '游泳', strength_training: '力量训练', cardio: '有氧', yoga: '瑜伽', other: '其他' };
export const activityColors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)'];
export function dateKey(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
export function shiftDay(date: string, offset: number): string { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + offset); return dateKey(value); }
export function average(values: Array<number | null>): number | null { const valid = values.filter((v): v is number => v !== null && Number.isFinite(v)); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; }
export function change(current: number | null, previous: number | null): string { return current === null || previous === null || previous === 0 ? '暂无对比' : `${current >= previous ? '↑' : '↓'} ${Math.abs((current - previous) / previous * 100).toFixed(0)}%`; }
export type RangePreset = 'month' | '3m' | '6m' | '1y' | 'custom';
export interface DateRange { from: string; to: string; preset: RangePreset }
export const rangePresets: Array<{ id: Exclude<RangePreset, 'custom'>; label: string }> = [
  { id: 'month', label: '本月' }, { id: '3m', label: '近 3 月' }, { id: '6m', label: '近半年' }, { id: '1y', label: '近 1 年' },
];
/** Days before the range the page also loads, for 7-day comparisons and the 12-week activity bars. */
export const CONTEXT_DAYS = 90;
/** Beyond this many days the trend charts show weekly averages instead of daily points. */
export const WEEKLY_TREND_THRESHOLD = 120;

export function monthEnd(month: string): string { return dateKey(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0)); }
export function daysBetween(from: string, to: string): number { return Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000) + 1; }
export function presetRange(preset: Exclude<RangePreset, 'custom'>, today: string): DateRange {
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today, preset };
  const start = new Date(`${today}T12:00:00`);
  start.setMonth(start.getMonth() - (preset === '3m' ? 3 : preset === '6m' ? 6 : 12));
  return { from: shiftDay(dateKey(start), 1), to: today, preset };
}
/** The calendar month a range covers exactly, if it is one; such ranges keep the month calendar. */
export function singleMonth(range: DateRange, today: string): string | null {
  const month = range.from.slice(0, 7);
  return range.from === `${month}-01` && (range.to === monthEnd(month) || (range.to === today && today.slice(0, 7) === month)) ? month : null;
}
export function monthRange(month: string, today: string): DateRange {
  const end = monthEnd(month);
  return { from: `${month}-01`, to: end < today ? end : today, preset: month === today.slice(0, 7) ? 'month' : 'custom' };
}
export function rangeLabel(range: DateRange, today: string): string {
  const month = singleMonth(range, today);
  if (month) return `${month.slice(0, 4)}年 ${Number(month.slice(5))}月`;
  if (range.preset !== 'custom') return rangePresets.find(p => p.id === range.preset)!.label;
  const format = (date: string) => date.slice(0, 4) === today.slice(0, 4) ? `${Number(date.slice(5, 7))}/${Number(date.slice(8))}` : date.replaceAll('-', '/');
  return `${format(range.from)} – ${format(range.to)}`;
}
export function dateList(from: string, to: string): string[] { const dates: string[] = []; for (let date = from; date <= to; date = shiftDay(date, 1)) dates.push(date); return dates; }

export function dashboardPeriod(trends: GarminDailyPoint[], activities: GarminActivity[], from: string, to: string) {
  const end = to;
  const inRange = (date: string, start: string, finish: string) => date >= start && date <= finish;
  const recent = trends.filter(p => inRange(p.date, shiftDay(end, -6), end));
  const previous = trends.filter(p => inRange(p.date, shiftDay(end, -13), shiftDay(end, -7)));
  const weeklySum = (rows: GarminDailyPoint[]) => rows.some(p => p.intensity_minutes !== null) ? rows.reduce((n, p) => n + (p.intensity_minutes ?? 0), 0) : null;
  const rangeRows = trends.filter(p => inRange(p.date, from, end));
  const hrvRows = rangeRows.filter(p => p.hrv_last_night !== null || p.hrv_weekly_avg !== null);
  return { end, rangeRows, rangeActivities: activities.filter(a => inRange(a.date, from, end)), recent, previous,
    sleep: average(recent.map(p => p.sleep_score)), previousSleep: average(previous.map(p => p.sleep_score)),
    intensity: weeklySum(recent), previousIntensity: weeklySum(previous),
    fitness: trends.filter(p => p.date <= end && p.fitness_age !== null).at(-1) ?? null,
    hrvAverage: average(hrvRows.map(p => p.hrv_last_night ?? p.hrv_weekly_avg)),
    hrvRecords: hrvRows.length,
  };
}

export interface HeatmapCell { date: string; inRange: boolean; count: number; minutes: number; level: 0 | 1 | 2 | 3 | 4 }
/**
 * A year-style activity heatmap: one column per week (Sunday first), padded to
 * whole weeks so every column has seven cells. Level follows the day's total
 * activity minutes, not the session count, so one long ride outranks two walks.
 */
export function activityHeatmap(activities: GarminActivity[], from: string, to: string): { weeks: HeatmapCell[][]; months: Array<{ column: number; label: string }> } {
  const byDate = new Map<string, { count: number; minutes: number }>();
  for (const a of activities) { const day = byDate.get(a.date) ?? { count: 0, minutes: 0 }; day.count++; day.minutes += a.duration_seconds / 60; byDate.set(a.date, day); }
  const start = shiftDay(from, -new Date(`${from}T12:00:00`).getDay());
  const weeks: HeatmapCell[][] = [];
  const months: Array<{ column: number; label: string }> = [];
  for (let date = start; date <= to; date = shiftDay(date, 1)) {
    if (new Date(`${date}T12:00:00`).getDay() === 0) weeks.push([]);
    const day = byDate.get(date) ?? { count: 0, minutes: 0 };
    const inRange = date >= from && date <= to;
    const level = !inRange || !day.count ? 0 : day.minutes < 30 ? 1 : day.minutes < 60 ? 2 : day.minutes < 90 ? 3 : 4;
    weeks.at(-1)!.push({ date, inRange, count: inRange ? day.count : 0, minutes: inRange ? day.minutes : 0, level });
    if (inRange && (date === from || date.endsWith('-01'))) {
      const label = { column: weeks.length - 1, label: `${Number(date.slice(5, 7))}月` };
      const last = months.at(-1);
      // Labels need two columns of room. A range starting at a month's tail
      // yields to the next month, which owns most of those first columns.
      if (!last || label.column > last.column + 1) months.push(label);
      else if (months.length === 1 && !from.endsWith('-01')) months[0] = label;
    }
  }
  return { weeks, months };
}

/** Daily points for short ranges; weekly averages (labelled by week start) for long ones. */
export function trendSeries(data: GarminDailyPoint[], from: string, to: string, value: (row: GarminDailyPoint) => number | null): Array<{ date: string; value: number | null }> {
  const lookup = new Map(data.map(p => [p.date, p]));
  const dates = dateList(from, to);
  const label = (date: string) => date.slice(5).replace('-', '/');
  if (dates.length <= WEEKLY_TREND_THRESHOLD) return dates.map(date => { const row = lookup.get(date); return { date: label(date), value: row ? value(row) : null }; });
  const series: Array<{ date: string; value: number | null }> = [];
  for (let i = 0; i < dates.length; i += 7) {
    const week = dates.slice(i, i + 7);
    const avg = average(week.map(date => { const row = lookup.get(date); return row ? value(row) : null; }));
    series.push({ date: label(week[0]!), value: avg === null ? null : Math.round(avg * 10) / 10 });
  }
  return series;
}
