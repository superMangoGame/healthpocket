"use client";

import { ArrowClockwise, CaretDown, CaretUp, Sparkle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { AdviceContent } from "@/components/AdviceContent";
import { apiFetch, withProfile } from "@/lib/api";
import type { DailyAdvice } from "@/lib/types";

/**
 * The AI 洞察 page's advice, the one place that reads the checkup reports and the
 * last 30 days of Garmin together. It sits above the chat input and folds away
 * once read, so the conversation keeps its room.
 */
export function CombinedAdvice({ profileId }: { profileId: string | null }) {
  const [advice, setAdvice] = useState<DailyAdvice | null>(null);
  const [open, setOpen] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!profileId) return;
    const controller = new AbortController();
    setAdvice(null); setError("");
    apiFetch<DailyAdvice | null>(withProfile("/ai/advice", profileId), { signal: controller.signal })
      .then(setAdvice)
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取 AI 建议"); });
    return () => controller.abort();
  }, [profileId]);

  const generate = async () => {
    if (!profileId) return;
    setRunning(true); setError(""); setOpen(true);
    try {
      setAdvice(await apiFetch<DailyAdvice>("/ai/advice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile_id: profileId }) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "AI 建议生成失败"); }
    finally { setRunning(false); }
  };

  return (
    <section className="gd-advice combined-advice">
      <div className="gd-advice-head">
        <h3><Sparkle weight="fill" />AI 综合建议<small>体检报告 + Garmin</small></h3>
        <div className="combined-advice-actions">
          <button className="button" disabled={running} onClick={() => void generate()}><ArrowClockwise className={running ? "batch-spinner" : ""} />{running ? "分析中…" : advice ? "重新分析" : "生成建议"}</button>
          {advice && <button className="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <CaretUp /> : <CaretDown />}{open ? "收起" : "展开"}</button>}
        </div>
      </div>
      {error && <p className="gd-advice-error">{error}</p>}
      {running && <p className="gd-advice-hint">正在结合体检报告和最近 30 天的 Garmin 数据生成建议，约需 20–60 秒…</p>}
      {advice ? open && <AdviceContent advice={advice} />
        : !running && !error && <p className="gd-advice-hint">让 AI 把体检报告和最近 30 天的 Garmin 记录（如已同步）放在一起看，给出按优先级排序的生活方式建议。也可以在下方直接提问。</p>}
    </section>
  );
}
