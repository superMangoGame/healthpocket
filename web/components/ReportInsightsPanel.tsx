"use client";

import { ArrowClockwise, Brain } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, withProfile } from "@/lib/api";
import type { AiInsight } from "@/lib/types";

const LEVEL_LABEL = { important: "重点", attention: "关注", observation: "观察" } as const;

/**
 * The overview page's AI read of the checkup reports alone; Garmin advice lives
 * on the daily page. Each highlight links to the report rows it rests on.
 */
export function ReportInsightsPanel({ profileId }: { profileId: string | null }) {
  const [insight, setInsight] = useState<AiInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!profileId) return;
    const controller = new AbortController();
    setLoading(true); setInsight(null); setError("");
    apiFetch<AiInsight[]>(withProfile("/ai/insights", profileId), { signal: controller.signal })
      .then((list) => setInsight(list.find((item) => item.dimension === "comprehensive") ?? null))
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取 AI 洞察"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [profileId]);

  const generate = async () => {
    if (!profileId) return;
    setRunning(true); setError("");
    try {
      setInsight(await apiFetch<AiInsight>("/ai/insights", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile_id: profileId, dimension: "comprehensive", year_from: null, year_to: null }) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "AI 分析失败"); }
    finally { setRunning(false); }
  };

  const evidence = new Map((insight?.evidence ?? []).map((item) => [item.id, item]));
  return (
    <section className="panel report-insights">
      <div className="report-insights-head">
        <span className="health-chat-icon"><Brain weight="duotone" /></span>
        <div><span className="eyebrow">AI 洞察 · 基于体检报告</span><h2>体检报告解读</h2></div>
        <button className="button" disabled={running || loading} onClick={() => void generate()}><ArrowClockwise className={running ? "batch-spinner" : ""} />{running ? "分析中…" : insight ? "重新分析" : "生成 AI 洞察"}</button>
      </div>
      {error && <p className="gd-advice-error">{error}{/配置|API Key|模型/.test(error) && <> · <Link className="link" href="/settings">去设置</Link></>}</p>}
      {running && <p className="gd-advice-hint">正在阅读所有已解析的体检报告，约需 20–60 秒…</p>}
      {loading ? <div className="skeleton" style={{ height: 120, borderRadius: 11 }} />
        : !insight ? !running && <p className="gd-advice-hint">汇总所有已解析报告的指标与结论，每条都标注出处。睡眠和运动方面的建议在「日常健康」，两者结合的建议在「AI 洞察」。</p>
        : <>
          {insight.stale && <p className="report-insights-stale">报告有新增或修改，这份解读可能已过时，可点击「重新分析」。</p>}
          <p className="gd-advice-summary">{insight.content.summary}</p>
          <div className="report-insights-grid">
            {insight.content.highlights.map((item, index) => (
              <article key={index} className={`gd-insight level-${item.level}`}>
                <div>
                  <h3>{item.title}<em>{LEVEL_LABEL[item.level]}</em></h3>
                  <p>{item.explanation}</p>
                  <div className="report-insight-sources">
                    {item.evidence_ids.map((id) => evidence.get(id)).filter((row) => row !== undefined).map((row) => (
                      <Link key={row.id} href={`/reports/detail?id=${row.report_id}`} title={`第 ${row.page} 页${row.reference ? ` · 参考 ${row.reference}` : ""}`}>{row.exam_date ?? row.year} · {row.title}{row.value ? ` ${row.value}` : ""}</Link>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {(insight.content.doctor_questions.length > 0 || insight.content.limitations.length > 0) && (
            <details className="report-insights-more">
              <summary>就诊时可以问的问题 · 数据局限</summary>
              {insight.content.doctor_questions.length > 0 && <ul>{insight.content.doctor_questions.map((text, i) => <li key={i}>{text}</li>)}</ul>}
              {insight.content.limitations.map((text, i) => <p key={i}>{text}</p>)}
            </details>
          )}
          <small className="gd-advice-meta">{insight.model} · {new Date(insight.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
        </>}
    </section>
  );
}
