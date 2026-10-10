"use client";

import { Barbell, FileText, Heart, MoonStars, PersonSimpleRun, Sparkle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { DailyAdvice } from "@/lib/types";

export const CATEGORY_ICON: Record<string, ReactNode> = {
  body_age: <PersonSimpleRun weight="fill" />,
  sleep: <MoonStars weight="fill" />,
  activity: <Barbell weight="fill" />,
  recovery: <Heart weight="fill" />,
  checkup: <FileText weight="fill" />,
  nutrition: <Sparkle weight="fill" />,
};
const PRIORITY_LABEL = { high: "优先", medium: "建议", low: "可选" } as const;

/** One saved AI advice: summary, prioritized actions with their reasons folded away, cautions. */
export function AdviceContent({ advice }: { advice: DailyAdvice }) {
  return <>
    <p className="gd-advice-summary">{advice.content.summary}</p>
    <ol className="gd-advice-list">
      {advice.content.recommendations.map((item, index) => (
        <li key={index}>
          <h4><span className="gd-icon">{CATEGORY_ICON[item.category] ?? <Sparkle weight="fill" />}</span>{item.title}<em className={`priority-${item.priority}`}>{PRIORITY_LABEL[item.priority]}</em></h4>
          <ul>{item.actions.map((action, i) => <li key={i}>{action}</li>)}</ul>
          <details><summary>依据</summary><p>{item.why}</p></details>
        </li>
      ))}
    </ol>
    {advice.content.cautions.length > 0 && <div className="gd-advice-cautions">{advice.content.cautions.map((text, i) => <p key={i}>{text}</p>)}</div>}
    <small className="gd-advice-meta">{advice.model} · {new Date(advice.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}{advice.range ? ` · Garmin 数据 ${advice.range.from} 至 ${advice.range.to}` : ""}</small>
  </>;
}
