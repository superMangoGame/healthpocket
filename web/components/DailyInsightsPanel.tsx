"use client";

import { ArrowClockwise, CheckCircle, Robot, Sparkle, Warning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { AdviceContent, CATEGORY_ICON } from "@/components/AdviceContent";
import { apiFetch, withProfile } from "@/lib/api";
import type { DailyAdvice, DailyInsight, DailyInsights, FitnessAge } from "@/lib/types";

const LEVEL_LABEL = { important: "重点", attention: "关注", good: "良好" } as const;

/**
 * The full-width "健康洞察" section of the daily page, from Garmin data only
 * (checkup reports are read on the overview page). Cards state what the data
 * shows; the advice below is one list - the AI's once generated, otherwise the
 * rules' - so the two never sit side by side disagreeing.
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
      <h2><Robot />健康洞察 <span>基于 Garmin 数据</span></h2>
      <p>{from} 至 {to} 的睡眠、运动与恢复记录。体检报告的解读在「健康总览」。</p>
      {error && <div className="error" role="alert">{error}</div>}
      {loading && !data ? <div className="skeleton" style={{ height: 320, borderRadius: 11 }} /> : <>
        <BodyAgeCard fitness={data?.fitness_age ?? null} />
        {insights.map((item) => <InsightCard key={item.id} insight={item} />)}
        {!insights.length && !data?.fitness_age && <p className="gd-insight-empty">同步 Garmin 数据后，这里会给出睡眠、运动和恢复方面的洞察。</p>}
        <AdviceSection advice={advice} rules={data?.insights ?? []} advising={advising} error={adviceError} onGenerate={() => void generate()} />
      </>}
    </section>
  );
}

function BodyAgeCard({ fitness }: { fitness: FitnessAge | null }) {
  if (!fitness) {
    return <article className="gd-bodyage empty"><span className="gd-icon">{CATEGORY_ICON.body_age}</span><div><h3>身体年龄</h3><p>暂无数据。点击右上角「手动同步」从 Garmin 获取身体年龄及其影响因素。</p></div></article>;
  }
  const gap = fitness.chronological_age !== null ? Math.round((fitness.chronological_age - fitness.fitness_age) * 10) / 10 : null;
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
      </div>
    </article>
  );
}

function AdviceSection({ advice, rules, advising, error, onGenerate }: { advice: DailyAdvice | null; rules: DailyInsight[]; advising: boolean; error: string; onGenerate: () => void }) {
  const pending = rules.filter((item) => item.level !== "good");
  return (
    <section className="gd-advice">
      <div className="gd-advice-head">
        <h3><Sparkle weight="fill" />{advice ? "AI 个性化建议" : "建议"}</h3>
        <button className="button" disabled={advising} onClick={onGenerate}>
          <ArrowClockwise className={advising ? "batch-spinner" : ""} />{advising ? "分析中…" : advice ? "重新分析" : "AI 深度分析"}
        </button>
      </div>
      {error && <p className="gd-advice-error">{error}{/未配置|API Key|模型/.test(error) ? "，可在设置页配置 AI 模型。" : ""}</p>}
      {advising && <p className="gd-advice-hint">正在根据睡眠、运动、恢复和身体年龄生成建议，约需 20–60 秒…</p>}
      {advice ? <AdviceContent advice={advice} /> : <>
        {pending.length ? <ul className="gd-advice-rules">{pending.map((item) => <li key={item.id}><b>{item.title}：</b>{item.advice}</li>)}</ul>
          : rules.length > 0 && <p className="gd-advice-hint">各项都在目标范围内，保持当前的训练与作息即可。</p>}
        {!advising && rules.length > 0 && <p className="gd-advice-hint">以上是按通用标准生成的建议。点击「AI 深度分析」，让 AI 结合你的数据给出排好优先级的个性化建议，生成后会替换这里的内容。</p>}
      </>}
    </section>
  );
}
