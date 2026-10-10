"use client";

import { ArrowClockwise, Barbell, CheckCircle, FileText, Heart, MoonStars, PersonSimpleRun, Robot, Sparkle, Warning } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, withProfile } from "@/lib/api";
import type { DailyAdvice, DailyInsight, DailyInsights, FitnessAge } from "@/lib/types";

const CATEGORY_ICON: Record<string, ReactNode> = {
  body_age: <PersonSimpleRun weight="fill" />,
  sleep: <MoonStars weight="fill" />,
  activity: <Barbell weight="fill" />,
  recovery: <Heart weight="fill" />,
  report: <FileText weight="fill" />,
  checkup: <FileText weight="fill" />,
  nutrition: <Sparkle weight="fill" />,
};
const LEVEL_LABEL = { important: "重点", attention: "关注", good: "良好" } as const;
const PRIORITY_LABEL = { high: "优先", medium: "建议", low: "可选" } as const;

/**
 * The full-width "健康洞察" section of the daily page: Garmin body age with what moves it,
 * rule-based insights that join the checkup report with sleep, training and
 * recovery, and on demand an AI write-up of the same data.
 */
export function DailyInsightsPanel({ profileId, from, to, refreshKey, onFitnessAge }: {
  profileId: string | null; from: string; to: string; refreshKey: string | null;
  onFitnessAge?: (fitness: FitnessAge | null) => void;
}) {
  const [data, setData] = useState<DailyInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [advice, setAdvice] = useState<DailyAdvice | null>(null);
  const [advising, setAdvising] = useState(false);
  const [adviceError, setAdviceError] = useState("");

  useEffect(() => {
    if (!profileId) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    apiFetch<DailyInsights>(withProfile(`/daily/insights?from=${from}&to=${to}`, profileId), { signal: controller.signal })
      .then((result) => { setData(result); setAdvice(result.advice); onFitnessAge?.(result.fitness_age); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法生成健康洞察"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [profileId, from, to, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    if (!profileId) return;
    setAdvising(true); setAdviceError("");
    try {
      setAdvice(await apiFetch<DailyAdvice>("/daily/advice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile_id: profileId, from, to }) }));
    } catch (reason) { setAdviceError(reason instanceof Error ? reason.message : "AI 分析失败"); }
    finally { setAdvising(false); }
  };

  const insights = (data?.insights ?? []).filter((item) => item.category !== "body_age");
  return (
    <section className="gd-card gd-insights">
      <h2><Robot />健康洞察 <span>体检 × 睡眠 × 运动</span></h2>
      <p>结合最近一次体检报告和{from} 至 {to} 的 Garmin 记录。</p>
      {error && <div className="error" role="alert">{error}</div>}
      {loading && !data ? <div className="skeleton" style={{ height: 320, borderRadius: 11 }} /> : <>
        <BodyAgeCard fitness={data?.fitness_age ?? null} />
        {insights.map((item) => <InsightCard key={item.id} insight={item} />)}
        {!insights.length && !data?.fitness_age && <p className="gd-insight-empty">同步 Garmin 数据或上传体检报告后，这里会给出结合两者的建议。</p>}
        <AdviceSection advice={advice} advising={advising} error={adviceError} onGenerate={() => void generate()} />
      </>}
    </section>
  );
}

function BodyAgeCard({ fitness }: { fitness: FitnessAge | null }) {
  if (!fitness) {
    return <article className="gd-bodyage empty"><span className="gd-icon">{CATEGORY_ICON.body_age}</span><div><h3>身体年龄</h3><p>暂无数据。点击右上角「手动同步」从 Garmin 获取身体年龄及其影响因素。</p></div></article>;
  }
  const gap = fitness.chronological_age !== null ? Math.round((fitness.chronological_age - fitness.fitness_age) * 10) / 10 : null;
  const weak = fitness.components.filter((item) => !item.on_target);
  return (
    <article className="gd-bodyage">
      <div className="gd-bodyage-head">
        <div>
          <h3>身体年龄</h3>
          <strong>{fitness.fitness_age}<small>岁</small></strong>
        </div>
        <div className="gd-bodyage-meta">
          {gap !== null && <span className={gap >= 0 ? "good" : "bad"}>{gap >= 0 ? `比实际年轻 ${gap} 岁` : `比实际大 ${-gap} 岁`}</span>}
          {fitness.chronological_age !== null && <small>实际年龄 {fitness.chronological_age} 岁</small>}
          {fitness.achievable_fitness_age !== null && fitness.achievable_fitness_age < fitness.fitness_age && <small>可达到 {fitness.achievable_fitness_age} 岁</small>}
          <small>Garmin · {fitness.date}</small>
        </div>
      </div>
      <ul className="gd-bodyage-factors">
        {fitness.components.map((item) => (
          <li key={item.key} className={item.on_target ? "ok" : "off"}>
            {item.on_target ? <CheckCircle weight="fill" /> : <Warning weight="fill" />}
            <span>{item.label}</span>
            <b>{item.value}{item.unit && ` ${item.unit}`}</b>
            <small>目标 {item.target}</small>
          </li>
        ))}
      </ul>
      <div className="gd-bodyage-advice">
        <h4>改善建议</h4>
        {(weak.length ? weak : fitness.components.slice(0, 1)).map((item) => <p key={item.key}><b>{item.label}：</b>{item.advice}</p>)}
      </div>
    </article>
  );
}

function InsightCard({ insight }: { insight: DailyInsight }) {
  return (
    <article className={`gd-insight level-${insight.level}`}>
      <span className="gd-icon">{CATEGORY_ICON[insight.category]}</span>
      <div>
        <h3>{insight.title}<em>{LEVEL_LABEL[insight.level]}</em></h3>
        <p>{insight.finding}</p>
        <p className="gd-insight-advice">{insight.advice}</p>
        <small className="gd-insight-sources">{insight.sources.join(" · ")}</small>
      </div>
    </article>
  );
}

function AdviceSection({ advice, advising, error, onGenerate }: { advice: DailyAdvice | null; advising: boolean; error: string; onGenerate: () => void }) {
  return (
    <section className="gd-advice">
      <div className="gd-advice-head">
        <h3><Sparkle weight="fill" />AI 个性化建议</h3>
        <button className="button" disabled={advising} onClick={onGenerate}>
          <ArrowClockwise className={advising ? "batch-spinner" : ""} />{advising ? "分析中…" : advice ? "重新分析" : "AI 深度分析"}
        </button>
      </div>
      {error && <p className="gd-advice-error">{error}{/未配置|API Key|模型/.test(error) ? "，可在设置页配置 AI 模型。" : ""}</p>}
      {!advice && !error && <p className="gd-advice-hint">{advising ? "正在结合体检、睡眠、运动和身体年龄生成建议，约需 20–60 秒…" : "让已配置的 AI 模型综合所有数据，给出按优先级排序、可执行的建议。"}</p>}
      {advice && <>
        <p className="gd-advice-summary">{advice.content.summary}</p>
        <ol className="gd-advice-list">
          {advice.content.recommendations.map((item, index) => (
            <li key={index}>
              <h4><span className="gd-icon">{CATEGORY_ICON[item.category] ?? <Sparkle weight="fill" />}</span>{item.title}<em className={`priority-${item.priority}`}>{PRIORITY_LABEL[item.priority]}</em></h4>
              <p>{item.why}</p>
              <ul>{item.actions.map((action, i) => <li key={i}>{action}</li>)}</ul>
            </li>
          ))}
        </ol>
        {advice.content.cautions.length > 0 && <div className="gd-advice-cautions">{advice.content.cautions.map((text, i) => <p key={i}>{text}</p>)}</div>}
        <small className="gd-advice-meta">{advice.model} · {new Date(advice.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}{advice.range ? ` · 基于 ${advice.range.from} 至 ${advice.range.to}` : ""}</small>
      </>}
    </section>
  );
}
