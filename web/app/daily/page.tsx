"use client";

import { ArrowClockwise, ArrowRight, CalendarBlank, CaretLeft, CaretRight, ChartBar, Flame, Heart, MoonStars, PersonSimpleRun, Robot, Watch, X } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useProfiles } from '@/components/ProfileProvider';
import { HealthChat } from '@/components/HealthChat';
import { useHealthChatScope } from '@/components/HealthChatProvider';
import { apiFetch, ApiError, withProfile } from '@/lib/api';
import { activityColors, activityHeatmap, activityLabels, change, CONTEXT_DAYS, dashboardPeriod, dateKey, dateList, daysBetween, monthEnd, monthRange, presetRange, rangeLabel, rangePresets, shiftDay, singleMonth, trendSeries, WEEKLY_TREND_THRESHOLD, type DateRange } from '@/lib/garmin-dashboard';
import { DailyInsightsPanel } from '@/components/DailyInsightsPanel';
import type { FitnessAge, GarminDashboard, GarminSettings, GarminDailyPoint, GarminActivity } from '@/lib/types';

const number = (value: number | null | undefined) => value == null ? '—' : Math.round(value).toLocaleString('zh-CN');
const formatTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未同步';
const failureText = (reason: unknown, fallback: string) => reason instanceof ApiError ? [reason.message, reason.stage, reason.hint].filter(Boolean).join(' · ') : reason instanceof Error ? reason.message : fallback;
const CHAT_EXAMPLES = ['这段时间睡眠和 HRV 有什么变化？', '最近运动量和上个月比怎么样？', '我的身体年龄主要受什么影响？', '哪几天恢复得最差，可能是什么原因？'];

export default function DailyHealthPage() {
  const { activeProfile, activeProfileId } = useProfiles();
  const today = dateKey(new Date());
  const [data, setData] = useState<GarminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [range, setRange] = useState<DateRange>(() => presetRange('month', today));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [weeks, setWeeks] = useState(4);
  const [chat, setChat] = useState(false);
  const [fitness, setFitness] = useState<FitnessAge | null>(null);
  const currentProfile = useRef(activeProfileId);
  currentProfile.current = activeProfileId;
  // Load a margin before the range too: the 7-day comparisons and the 12-week
  // bars look back from the range's end, whatever its start.
  const loadFrom = useMemo(() => { const context = shiftDay(range.to, -CONTEXT_DAYS); return context < range.from ? context : range.from; }, [range]);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!activeProfileId) { setLoading(false); return; }
    try {
      const result = await apiFetch<GarminDashboard>(withProfile(`/garmin/dashboard?from=${loadFrom}&to=${range.to}`, activeProfileId), { signal });
      if (currentProfile.current === activeProfileId) { setData(result); setSyncing(result.syncing); }
    } catch (reason) { if (!signal?.aborted && currentProfile.current === activeProfileId) setError(reason instanceof Error ? reason.message : '无法读取佳明数据'); }
    finally { if (!signal?.aborted && currentProfile.current === activeProfileId) setLoading(false); }
  }, [activeProfileId, loadFrom, range.to]);
  useEffect(() => { setData(null); setFitness(null); setLoading(true); setError(''); setNotice(''); setSelectedDate(null); setSyncing(false); }, [activeProfileId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  // A sync runs in the background on the plugin side; follow it here and read
  // its outcome from the settings once it is no longer running.
  useEffect(() => {
    if (!syncing) return;
    let disposed = false;
    const poll = async () => {
      try {
        const settings = await apiFetch<GarminSettings>('/garmin/settings');
        if (disposed) return;
        setStage(settings.running?.stage ?? '正在同步'); setProgress(settings.sync_progress ?? null);
        if (settings.syncing) return;
        setSyncing(false); setProgress(null);
        if (settings.last_sync_error) setError(settings.last_sync_error);
        else if (settings.last_sync_result) setNotice(`同步完成：更新 ${settings.last_sync_result.synced_days} 天健康数据、${settings.last_sync_result.synced_activities} 条运动记录。`);
        window.dispatchEvent(new Event('healthpocket:garmin-status'));
        await load();
      } catch { /* Keep polling; the next tick will try again. */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [syncing, load]);

  const shownTo = range.to < today ? range.to : today;
  useHealthChatScope({ garmin_range: { from: range.from, to: shownTo } });
  const storedDates = useMemo(() => new Set((data?.trends ?? []).map(p => p.date)), [data]);
  const missing = useMemo(() => dateList(range.from, shownTo).filter(date => !storedDates.has(date)).length, [range.from, shownTo, storedDates]);
  const sync = async () => {
    if (!activeProfileId || syncing) return;
    setError(''); setNotice(''); setStage('准备同步…'); setProgress(null);
    try {
      // Missing days in the range → backfill exactly those; otherwise the usual
      // incremental sync from the newest stored day.
      await apiFetch<GarminSettings>('/garmin/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: activeProfileId, background: true, ...(missing ? { from: range.from, to: shownTo } : {}) }) });
      setSyncing(true);
    } catch (reason) { setError(failureText(reason, '同步失败')); }
  };

  const month = singleMonth(range, today);
  const label = rangeLabel(range, today);
  const period = useMemo(() => dashboardPeriod(data?.trends ?? [], data?.activities ?? [], range.from, shownTo), [data, range.from, shownTo]);
  const types = useMemo(() => { const groups = new Map<string, number>(); period.rangeActivities.forEach(a => groups.set(a.type, (groups.get(a.type) ?? 0) + 1)); return [...groups].sort((a,b) => b[1]-a[1]).map(([type, count], i) => ({ type, name: activityLabels[type] ?? type, count, color: activityColors[i % activityColors.length] })); }, [period.rangeActivities]);
  const bars = Array.from({ length: weeks }, (_, i) => { const start = shiftDay(period.end, -(weeks - i) * 7 + 1); const end = shiftDay(start, 6); return { date: start.slice(5).replace('-', '/'), count: (data?.activities ?? []).filter(a => a.date >= start && a.date <= end).length }; });
  const selected = period.rangeActivities.filter(a => a.date === selectedDate);
  const linked = data?.authenticated && data.account_profile_id === activeProfileId;
  const choose = (next: DateRange) => { setRange(next); setSelectedDate(null); setNotice(''); };
  const moveMonth = (offset: number) => { if (!month) return; const d = new Date(`${month}-01T12:00:00`); d.setMonth(d.getMonth() + offset); choose(monthRange(dateKey(d).slice(0, 7), today)); };
  const setBound = (bound: 'from' | 'to', value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    const next = { ...range, [bound]: value > today ? today : value, preset: 'custom' as const };
    if (next.from > next.to) { if (bound === 'from') next.to = next.from; else next.from = next.to; }
    choose(next);
  };
  const progressText = progress && progress.total ? ` · ${progress.done}/${progress.total} 天` : '';

  return <div className="garmin-dashboard">
    <header className="gd-header"><div><h1>日常健康</h1><p>{activeProfile?.name || '当前档案'} · 来自 Garmin Connect 的每日记录</p></div><div className="gd-header-actions"><Link href="/settings" className="gd-device"><Watch size={34} /><span>Garmin Connect<small><i className={linked ? 'connected' : ''} />{linked ? `已同步 ${formatTime(data?.last_sync_at)}` : '前往设置连接佳明'}</small></span></Link><button className="gd-sync" onClick={() => void sync()} disabled={!linked || syncing}><ArrowClockwise className={syncing ? 'batch-spinner' : ''} />{syncing ? `正在同步${progressText}` : missing ? `补拉 ${missing} 天数据` : '手动同步'}</button></div></header>
    <div className="gd-range" role="group" aria-label="日期范围">
      <div className="gd-range-presets">{rangePresets.map(p => <button key={p.id} aria-pressed={range.preset === p.id} onClick={() => choose(presetRange(p.id, today))}>{p.label}</button>)}</div>
      <div className="gd-range-dates">
        {month && <button className="gd-range-step" aria-label="上个月" onClick={() => moveMonth(-1)}><CaretLeft /></button>}
        <input type="date" aria-label="起始日期" value={range.from} max={today} onChange={e => setBound('from', e.target.value)} />
        <span aria-hidden>–</span>
        <input type="date" aria-label="结束日期" value={range.to} min={range.from} max={today} onChange={e => setBound('to', e.target.value)} />
        {month && <button className="gd-range-step" aria-label="下个月" disabled={month >= today.slice(0, 7)} onClick={() => moveMonth(1)}><CaretRight /></button>}
      </div>
      <span className="gd-range-status">{syncing ? `${stage}${progressText}` : `${daysBetween(range.from, shownTo)} 天 · 已下载 ${daysBetween(range.from, shownTo) - missing} 天`}</span>
      {syncing && progress && progress.total > 0 && <div className="gd-range-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><i style={{ width: `${progress.done / progress.total * 100}%` }} /></div>}
    </div>
    {error && <div className="error" role="alert">{error}</div>}{notice && <div className="gd-notice" role="status">{notice}</div>}
    {!loading && !linked && <div className="gd-notice">{data?.authenticated ? '当前档案未关联此佳明账号，请切换档案或在设置中重新关联。' : '尚未连接佳明，请先在设置中登录。'} <Link href="/settings">查看设置 <ArrowRight /></Link></div>}
    {!loading && linked && !data?.latest && <div className="gd-notice">登录成功。点击「补拉数据」，下载所选区间的健康数据及运动历史。</div>}
    {!loading && linked && data?.latest && period.rangeRows.length === 0 && <div className="gd-notice">{label}尚未下载健康快照。点击「补拉 {missing} 天数据」后可查看该区间的睡眠与 HRV 记录。</div>}
    {loading ? <div className="panel skeleton" style={{height: 600}} /> : <>
      <section className="gd-kpis">
        <Kpi icon={<PersonSimpleRun weight="bold" />} label="运动次数" value={data?.last_sync_at ? number(period.rangeActivities.length) : '—'} unit="次" note={label} tone="blue" />
        <Kpi icon={<Flame weight="fill" />} label="强度活动时间" value={number(period.intensity)} unit="分钟" note="近 7 天 · 中等 + 高强度 × 2" comparison={change(period.intensity, period.previousIntensity)} tone="orange" />
        <Kpi icon={<MoonStars weight="fill" />} label="平均睡眠分数" value={number(period.sleep)} unit="分" note={`近 7 天 · ${period.recent.filter(p => p.sleep_score !== null).length} 天记录`} comparison={change(period.sleep, period.previousSleep)} tone="purple" />
        <Kpi icon={<PersonSimpleRun weight="fill" />} label="身体年龄" value={fitness ? fitness.fitness_age.toFixed(1) : number(period.fitness?.fitness_age)} unit="岁" note={fitness ? (fitness.chronological_age !== null ? `实际年龄 ${fitness.chronological_age} 岁 · ${fitness.date}` : `最近记录 ${fitness.date}`) : period.fitness ? `最近记录 ${period.fitness.date}` : '同步后获取'} tone="green" />
      </section>
      <div className="gd-layout"><div className="gd-primary">
        <div className={`gd-top-grid${month ? '' : ' wide'}`}>
          {month ? <MonthCalendar month={month} today={today} activities={period.rangeActivities} types={types} selectedDate={selectedDate} onSelect={setSelectedDate} />
            : <Heatmap from={range.from} to={shownTo} today={today} label={label} activities={period.rangeActivities} selectedDate={selectedDate} onSelect={setSelectedDate} />}
          <section className="gd-card gd-stats"><div className="gd-card-title"><h2><ChartBar />运动统计</h2><select aria-label="运动统计范围" value={weeks} onChange={e => setWeeks(Number(e.target.value))}><option value={4}>近 4 周</option><option value={8}>近 8 周</option><option value={12}>近 12 周</option></select></div><div className="gd-stat-charts"><div className="gd-bars"><ResponsiveContainer width="100%" height="100%"><BarChart data={bars}><CartesianGrid vertical={false} stroke="var(--line)" /><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fontSize:11,fill:'var(--muted)'}} /><YAxis allowDecimals={false} axisLine={false} tickLine={false} width={24} tick={{fontSize:11,fill:'var(--muted)'}} /><Tooltip /><Bar dataKey="count" name="运动次数" fill="var(--accent)" radius={[3,3,0,0]} maxBarSize={24} /></BarChart></ResponsiveContainer></div><div className="gd-distribution"><p>{label} <strong>{period.rangeActivities.length}</strong> 次</p><div className="gd-donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={types.length ? types : [{count:1,color:'var(--line)',name:'暂无数据'}]} dataKey="count" innerRadius="62%" outerRadius="95%" paddingAngle={2}>{(types.length ? types : [{color:'var(--line)'}]).map((t,i)=><Cell key={i} fill={t.color} />)}</Pie>{types.length > 0 && <Tooltip />}</PieChart></ResponsiveContainer></div><div className="gd-type-list">{types.slice(0,4).map(t => <span key={t.type}><i style={{background:t.color}} />{t.name}<b>{t.count}</b></span>)}</div></div></div></section>
        </div>
        {selectedDate && <section className="gd-card gd-day-detail"><div className="gd-card-title"><h2>{selectedDate} · 运动记录</h2><button aria-label="关闭运动详情" onClick={()=>setSelectedDate(null)}><X /></button></div>{selected.length ? selected.map(a=><div key={a.activity_id}><PersonSimpleRun /><strong>{a.name}</strong><span>{activityLabels[a.type] ?? a.type} · {Math.round(a.duration_seconds/60)} 分钟{a.distance_m !== null ? ` · ${(a.distance_m/1000).toFixed(2)} km` : ''}</span></div>) : <p>当天没有已同步的运动记录。</p>}</section>}
        <div className="gd-trends"><Trend title="睡眠分数" icon={<MoonStars weight="fill" />} field="sleep_score" data={data?.trends ?? []} from={range.from} to={shownTo} label={label} unit="分" color="var(--series-1)" /><Trend title="HRV（毫秒）" icon={<Heart weight="fill" />} field="hrv_last_night" data={data?.trends ?? []} from={range.from} to={shownTo} label={label} unit="ms" color="var(--series-3)" /></div>
      </div><section className="gd-card gd-chat-teaser"><h2><Robot />AI 问答</h2><p>有什么想了解的？比如：</p><ul className="gd-examples">{CHAT_EXAMPLES.map(question => <li key={question}>“{question}”</li>)}</ul><button onClick={()=>setChat(true)}>向 AI 提问你的健康问题…<ArrowRight /></button><small>AI 会按需查询已同步的 Garmin 数据</small></section></div>
      <DailyInsightsPanel profileId={activeProfileId} from={range.from} to={shownTo} refreshKey={data?.last_sync_at ?? null} onFitnessAge={setFitness} />
    </>}
    {chat && <div className="gd-modal" role="dialog" aria-modal="true" aria-label="AI 健康问答" onKeyDown={e=>{if(e.key==='Escape')setChat(false);}}><div><button autoFocus className="gd-modal-close" aria-label="关闭 AI 问答" onClick={()=>setChat(false)}><X /></button><HealthChat profileId={activeProfileId} profileName={activeProfile?.name ?? '当前档案'} variant="daily" /></div></div>}
  </div>;
}

function MonthCalendar({month,today,activities,types,selectedDate,onSelect}:{month:string;today:string;activities:GarminActivity[];types:Array<{type:string;name:string;color:string}>;selectedDate:string|null;onSelect:(date:string|null)=>void}) {
  const days = Number(monthEnd(month).slice(8));
  const firstDay = new Date(`${month}-01T12:00:00`).getDay();
  return <section className="gd-card gd-calendar"><div className="gd-card-title"><h2><CalendarBlank />运动日历</h2><span>{month.replace('-', '年 ')}月</span></div><div className="gd-calendar-grid">{['日','一','二','三','四','五','六'].map(d => <small key={d}>{d}</small>)}{Array.from({length:firstDay}, (_, i) => <span key={`blank-${i}`} />)}{Array.from({length:days}, (_, i) => { const date = `${month}-${String(i+1).padStart(2,'0')}`; const events = activities.filter(a => a.date === date); return <button key={date} aria-label={`${date}，${events.length} 次运动`} aria-pressed={selectedDate === date} className={`${events.length ? 'has-activity' : ''} ${selectedDate === date ? 'selected' : ''} ${date === today ? 'today' : ''}`} onClick={() => onSelect(selectedDate === date ? null : date)}><span>{i+1}</span><div>{[...new Set(events.map(a=>a.type))].slice(0,3).map(type => <i key={type} style={{background:types.find(t=>t.type===type)?.color}} />)}</div></button>; })}</div><div className="gd-legend">{(types.length ? types : [{name:'暂无运动记录',color:'var(--faint)',type:'empty'}]).slice(0,4).map(t => <span key={t.type}><i style={{background:t.color}} />{t.name}</span>)}</div></section>;
}

function Heatmap({from,to,today,label,activities,selectedDate,onSelect}:{from:string;to:string;today:string;label:string;activities:GarminActivity[];selectedDate:string|null;onSelect:(date:string|null)=>void}) {
  const { weeks, months } = useMemo(() => activityHeatmap(activities, from, to), [activities, from, to]);
  const activeDays = weeks.flat().filter(c => c.count > 0).length;
  return <section className="gd-card gd-calendar gd-heatmap"><div className="gd-card-title"><h2><CalendarBlank />运动热力图</h2><span>{label} · {activeDays} 天有运动</span></div>
    <div className="gd-heatmap-scroll"><div className="gd-heatmap-body" style={{ ['--weeks' as string]: weeks.length }}>
      <div className="gd-heatmap-months" aria-hidden>{months.map(m => <span key={`${m.column}-${m.label}`} style={{ gridColumn: m.column + 1 }}>{m.label}</span>)}</div>
      <div className="gd-heatmap-days" aria-hidden><span /><span>一</span><span /><span>三</span><span /><span>五</span><span /></div>
      <div className="gd-heatmap-grid">{weeks.flat().map(cell => cell.inRange
        ? <button key={cell.date} data-level={cell.level} aria-pressed={selectedDate === cell.date} className={`${selectedDate === cell.date ? 'selected' : ''} ${cell.date === today ? 'today' : ''}`} title={`${cell.date} · ${cell.count ? `${cell.count} 次运动，${Math.round(cell.minutes)} 分钟` : '无运动'}`} aria-label={`${cell.date}，${cell.count} 次运动`} onClick={() => onSelect(selectedDate === cell.date ? null : cell.date)} />
        : <span key={cell.date} />)}</div>
    </div></div>
    <div className="gd-legend gd-heatmap-legend"><span>少</span>{[0,1,2,3,4].map(level => <i key={level} data-level={level} />)}<span>多</span><small>按当天运动分钟数着色</small></div>
  </section>;
}

function Kpi({icon,label,value,unit,note,comparison,tone}:{icon:ReactNode;label:string;value:string;unit:string;note:string;comparison?:string;tone:string}) {return <article className="gd-card gd-kpi"><span className={`gd-icon ${tone}`}>{icon}</span><div><h2>{label}</h2><div className="gd-kpi-value"><strong>{value}<small>{unit}</small></strong>{comparison && <span className={`gd-comparison${comparison.startsWith('↓') ? ' down' : ''}`}>{comparison}<small>较前 7 天</small></span>}</div><p>{note}</p></div></article>;}
function Trend({title,icon,field,data,from,to,label,unit,color}:{title:string;icon:ReactNode;field:'sleep_score'|'hrv_last_night';data:GarminDailyPoint[];from:string;to:string;label:string;unit:string;color:string}) {
  const value = (row: GarminDailyPoint) => field==='hrv_last_night' ? row.hrv_last_night ?? row.hrv_weekly_avg : row[field];
  const points = useMemo(() => trendSeries(data, from, to, value), [data, from, to, field]); // eslint-disable-line react-hooks/exhaustive-deps
  const weekly = daysBetween(from, to) > WEEKLY_TREND_THRESHOLD;
  const latest=data.filter(p=>p.date<=to && p.date>=from && value(p)!==null).at(-1);
  const latestValue=latest ? value(latest) : null;
  return <section className="gd-card gd-trend"><div className="gd-card-title"><h2><span className={`gd-icon ${field==='sleep_score'?'purple':'red'}`}>{icon}</span>{title}</h2><span>{label}{weekly ? ' · 周均值' : ''}</span></div><div className="gd-trend-value"><strong>{number(latestValue)}</strong> {unit}<small>{latest ? `最近记录 ${latest.date}${field==='hrv_last_night' && latest.hrv_last_night===null ? ' · 周均值' : ''}` : '暂无数据'}</small></div><div className="gd-line"><ResponsiveContainer width="100%" height="100%"><AreaChart data={points} margin={{top:10,right:8,left:-14,bottom:0}}><CartesianGrid vertical={false} stroke="var(--line)" /><XAxis dataKey="date" tick={{fontSize:10,fill:'var(--muted)'}} axisLine={false} tickLine={false} minTickGap={25} /><YAxis domain={field==='sleep_score'?[0,100]:[0,'auto']} tick={{fontSize:10,fill:'var(--muted)'}} axisLine={false} tickLine={false} width={42} /><Tooltip /><Area type="monotone" dataKey="value" name={weekly ? `${title} · 周均` : title} stroke={color} fill={color} fillOpacity={0.12} strokeWidth={2} dot={points.length > 60 ? false : {r:2,fill:color}} connectNulls={false} /></AreaChart></ResponsiveContainer></div></section>;
}
