"use client";

import { ArrowClockwise, FilePdf, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { UploadDialog } from "@/components/UploadDialog";
import { apiFetch, withProfile } from "@/lib/api";
import type { ReportSummary } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

const templateLabels: Record<string, string> = {
  "ikang-2018-2020": "爱康 2018-2020",
  "health100-2021-2023": "美年 2021-2023",
  "health100-2024-2025": "美年 2024-2025",
  unknown: "通用解析",
};

const parseLabels: Record<string, string> = {
  queued: "等待解析", processing: "解析中", completed: "解析完成", partial: "部分完成", failed: "解析失败",
};

export default function ReportsPage() {
  const { activeProfile, activeProfileId } = useProfiles();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    if (!activeProfileId) return;
    const request = ++requestVersion.current;
    setReports([]);
    setLoading(true);
    setError("");
    try {
      const nextReports = await apiFetch<ReportSummary[]>(withProfile("/reports", activeProfileId));
      if (request === requestVersion.current) setReports(nextReports);
    } catch (loadError) {
      if (request === requestVersion.current) setError(loadError instanceof Error ? loadError.message : "加载失败");
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [activeProfileId]);
  useEffect(() => { void load(); }, [load]);

  const remove = async (report: ReportSummary) => {
    if (!window.confirm(`删除 ${report.year || "未知年份"} 年报告及其全部解析结果？此操作无法撤销。`)) return;
    try { await apiFetch(`/reports/${report.id}`, { method: "DELETE" }); await load(); }
    catch (removeError) { setError(removeError instanceof Error ? removeError.message : "删除失败"); }
  };

  const reparse = async (report: ReportSummary) => {
    try { await apiFetch(`/reports/${report.id}/reparse`, { method: "POST" }); await load(); }
    catch (parseError) { setError(parseError instanceof Error ? parseError.message : "无法重新解析"); }
  };

  return (
    <>
      <header className="page-header">
        <div><h1 className="page-title">报告管理</h1><p className="page-subtitle">{activeProfile?.name || "当前档案"}的原始 PDF、结构化指标和来源页始终保持关联。</p></div>
        <UploadDialog onComplete={load} />
      </header>
      <div className="notice">报告仅保存在本机数据目录。低置信度字段会显示“部分完成”，但不会进入器官健康状态。</div>
      {error && <div className="error" style={{ marginTop: 16 }}>{error}</div>}
      <section className="section">
        <div className="section-head"><h2 className="section-title">报告库</h2><span className="muted mono">{reports.length} 份</span></div>
        {loading ? <div className="panel skeleton" style={{ height: 320 }} /> : reports.length === 0 ? (
          <div className="panel"><EmptyState title="报告库为空" description="导入 PDF 后，解析任务会自动开始。" action={<UploadDialog onComplete={load} />} /></div>
        ) : (
          <div className="panel table-scroll">
            <table className="data-table">
              <thead><tr><th>年份</th><th>体检日期</th><th>体检机构</th><th>解析模板</th><th>页数</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>{reports.map((report) => (
                <tr key={report.id}>
                  <td><Link className="link mono" href={`/reports/detail?id=${report.id}`}>{report.year || "-"}</Link></td>
                  <td className="mono">{report.exam_date || "待识别"}</td>
                  <td>{report.institution || "未识别机构"}</td>
                  <td>{templateLabels[report.template_type] || report.template_type}</td>
                  <td className="mono">{report.page_count || "-"}</td>
                  <td><span className={`status ${report.parse_status === "completed" ? "status-normal" : report.parse_status === "failed" ? "status-abnormal" : "status-attention"}`}>{parseLabels[report.parse_status] || report.parse_status}</span></td>
                  <td><div style={{ display: "flex", gap: 6 }}>
                    <Link className="button button-icon" href={`/reports/detail?id=${report.id}`} aria-label="打开报告"><FilePdf /></Link>
                    <button className="button button-icon" aria-label="重新解析" onClick={() => void reparse(report)}><ArrowClockwise /></button>
                    <button className="button button-icon button-danger" aria-label="删除报告" onClick={() => void remove(report)}><Trash /></button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
