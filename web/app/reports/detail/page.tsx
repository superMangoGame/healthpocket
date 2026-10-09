"use client";

import { ArrowLeft, FilePdf } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiFetch, apiUrl } from "@/lib/api";
import type { ReportDetail } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

function ReportDetailView() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") || "";
  const router = useRouter();
  const { activeProfileId } = useProfiles();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [tab, setTab] = useState<"measurements" | "findings">("measurements");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    apiFetch<ReportDetail>(`/reports/${id}`).then((value) => { setReport(value); setPage(1); }).catch((reason) => setError(reason.message));
  }, [id]);
  useEffect(() => {
    if (report && activeProfileId && report.profile_id !== activeProfileId) router.replace("/reports");
  }, [report, activeProfileId, router]);
  const categories = useMemo(() => {
    const grouped = new Map<string, ReportDetail["measurements"]>();
    for (const item of report?.measurements || []) grouped.set(item.category, [...(grouped.get(item.category) || []), item]);
    return grouped;
  }, [report]);

  if (error) return <div className="error">{error}</div>;
  if (!id) return <div className="error">缺少报告 ID，请从报告库进入。</div>;
  if (!report) return <div className="skeleton" style={{ height: "80dvh" }} />;
  return (
    <>
      <header className="page-header">
        <div>
          <Link href="/reports" className="link" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, marginBottom: 10 }}><ArrowLeft /> 返回报告库</Link>
          <h1 className="page-title">{report.year || "未知年份"} 年体检报告</h1>
          <p className="page-subtitle">{report.institution || "未识别机构"} · {report.exam_date || "日期待识别"} · {report.measurements.length} 项指标</p>
        </div>
        <a className="button" href={`${apiUrl(`/reports/${id}/file`)}#page=${page}`} target="_blank" rel="noreferrer"><FilePdf /> 新窗口打开</a>
      </header>
      <section className="report-detail-grid">
        <iframe key={page} className="pdf-frame" title="原始体检报告" src={`${apiUrl(`/reports/${id}/file`)}#page=${page}&view=FitH`} />
        <div className="panel detail-pane">
          <div className="detail-tabs" role="tablist">
            <button className={`detail-tab ${tab === "measurements" ? "active" : ""}`} onClick={() => setTab("measurements")}>结构化指标</button>
            <button className={`detail-tab ${tab === "findings" ? "active" : ""}`} onClick={() => setTab("findings")}>报告结论</button>
          </div>
          <div className="detail-scroll">
            {tab === "measurements" ? [...categories.entries()].map(([category, items]) => (
              <section className="category-block" key={category}>
                <h3>{category} <span className="muted mono">{items.length}</span></h3>
                {items.map((item) => (
                  <div className="measurement-row" key={item.id}>
                    <div><strong>{item.raw_name}</strong>{item.abbreviation && <span className="muted"> ({item.abbreviation})</span>}<div className={`muted ${item.confidence < .8 ? "confidence-low" : ""}`} style={{ fontSize: 10, marginTop: 3 }}>置信度 {Math.round(item.confidence * 100)}%</div></div>
                    <div className="mono"><strong>{item.value_numeric ?? item.value_text ?? "-"}</strong> <span className="muted">{item.unit}</span></div>
                    <div className="mono muted">{item.ref_text || "无参考区间"}</div>
                    <button onClick={() => setPage(item.page)}>第 {item.page} 页</button>
                  </div>
                ))}
              </section>
            )) : report.findings.map((finding) => (
              <article className="finding-row" key={finding.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}><strong>{finding.title}</strong><StatusBadge status={finding.severity} compact /></div>
                <p className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>{finding.content}</p>
                <button className="link" style={{ border: 0, background: "none", padding: 0, fontSize: 11 }} onClick={() => setPage(finding.page)}>定位到第 {finding.page} 页</button>
              </article>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

export default function ReportDetailPage() {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: "80dvh" }} />}>
      <ReportDetailView />
    </Suspense>
  );
}
