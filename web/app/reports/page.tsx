"use client";

import { ArrowClockwise, FilePdf, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { CategoryIcon } from "@/components/RecordCategory";
import { RecordTimeline } from "@/components/RecordTimeline";
import { UploadDialog } from "@/components/UploadDialog";
import { apiFetch, withProfile } from "@/lib/api";
import { CATEGORY_LABELS, TIMELINE_CATEGORIES, buildTimeline, countByCategory, isParsing, isTimelineCategory, type TimelineCategory } from "@/lib/records";
import type { MedicalRecord, ReportSummary } from "@/lib/types";
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

function ReportsView() {
  const searchParams = useSearchParams();
  const { activeProfile, activeProfileId } = useProfiles();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [records, setRecords] = useState<MedicalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ReportSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const query = searchParams.toString();
  const [view, setView] = useState<"timeline" | "table">("timeline");
  const [category, setCategory] = useState<TimelineCategory | "all">("all");
  const [year, setYear] = useState<number | "all">("all");

  useEffect(() => {
    const params = new URLSearchParams(query);
    const nextCategory = params.get("category");
    const nextYear = Number(params.get("year"));
    setView(params.get("view") === "table" ? "table" : "timeline");
    setCategory(isTimelineCategory(nextCategory) ? nextCategory : "all");
    setYear(Number.isInteger(nextYear) && nextYear > 1900 ? nextYear : "all");
  }, [query]);

  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    if (!activeProfileId) return;
    const request = ++requestVersion.current;
    setReports([]);
    setRecords([]);
    setLoading(true);
    setError("");
    try {
      const [nextReports, nextRecords] = await Promise.all([
        apiFetch<ReportSummary[]>(withProfile("/reports", activeProfileId)),
        apiFetch<MedicalRecord[]>(withProfile("/records", activeProfileId)),
      ]);
      if (request === requestVersion.current) {
        setReports(nextReports);
        setRecords(nextRecords);
      }
    } catch (loadError) {
      if (request === requestVersion.current) {
        setError(loadError instanceof Error ? loadError.message : "加载失败");
      }
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [activeProfileId]);

  useEffect(() => { void load(); }, [load]);

  const parsing = records.some((record) => record.files.some(isParsing));
  useEffect(() => {
    if (!parsing || !activeProfileId) return;
    const request = requestVersion.current;
    const timer = window.setTimeout(() => {
      void apiFetch<MedicalRecord[]>(withProfile("/records", activeProfileId))
        .then((next) => { if (request === requestVersion.current) setRecords(next); })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [parsing, records, activeProfileId]);

  const entries = useMemo(() => buildTimeline(reports, records), [reports, records]);
  const years = useMemo(() => [...new Set(entries.map((entry) => entry.year).filter((value): value is number => value !== null))].sort((a, b) => b - a), [entries]);
  const inYear = useMemo(() => (year === "all" ? entries : entries.filter((entry) => entry.year === year)), [entries, year]);
  const counts = useMemo(() => countByCategory(inYear), [inYear]);
  const filtered = category === "all" ? inYear : inYear.filter((entry) => entry.category === category);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await apiFetch(`/reports/${pendingDelete.id}`, { method: "DELETE" });
      setPendingDelete(null);
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const reparse = async (report: ReportSummary) => {
    try {
      await apiFetch(`/reports/${report.id}/reparse`, { method: "POST" });
      await load();
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "无法重新解析");
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">报告管理</h1>
          <p className="page-subtitle">
            {activeProfile?.name || "当前档案"}的体检报告、病历、影像与化验单按时间归档；原始文件仅存在本机，低置信度字段不会影响风险汇总。
          </p>
        </div>
        <div className="header-actions">
          <div className="segmented-control records-view-switch" role="tablist" aria-label="显示方式">
            <button type="button" role="tab" aria-selected={view === "timeline"} className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}>时间线</button>
            <button type="button" role="tab" aria-selected={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}>体检表格</button>
          </div>
          <UploadDialog onComplete={load} />
        </div>
      </header>

      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}

      <section className="reports-stage">
        {loading ? (
          <div className="panel skeleton-panel">
            <span className="skeleton skeleton-line w-35" />
            <span className="skeleton skeleton-block" />
          </div>
        ) : view === "timeline" ? (
          entries.length === 0 ? (
            <div className="panel">
              <EmptyState
                title="还没有任何报告"
                description="体检 PDF 导入后会自动解析指标；门诊病历、CT 影像、化验单可以拍照或扫描后按日期归档。"
                action={<UploadDialog onComplete={load} />}
              />
            </div>
          ) : (
            <>
              <div className="timeline-toolbar">
                <div className="category-filter" role="group" aria-label="按类别筛选">
                  <button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")}>
                    全部 <span className="mono">{inYear.length}</span>
                  </button>
                  {TIMELINE_CATEGORIES.filter((item) => counts[item] || item === category).map((item) => (
                    <button
                      type="button"
                      key={item}
                      data-category={item}
                      aria-pressed={category === item}
                      onClick={() => setCategory(category === item ? "all" : item)}
                    >
                      <CategoryIcon category={item} size={14} weight={category === item ? "fill" : "regular"} />
                      {CATEGORY_LABELS[item]} <span className="mono">{counts[item] ?? 0}</span>
                    </button>
                  ))}
                </div>
                <select
                  className="select"
                  aria-label="按年份筛选"
                  value={year}
                  onChange={(event) => setYear(event.target.value === "all" ? "all" : Number(event.target.value))}
                >
                  <option value="all">全部年份</option>
                  {years.map((value) => <option key={value} value={value}>{value} 年</option>)}
                </select>
              </div>
              {filtered.length ? (
                <RecordTimeline entries={filtered} />
              ) : (
                <div className="panel timeline-empty">
                  该筛选条件下没有记录。
                  <button type="button" className="link" onClick={() => { setCategory("all"); setYear("all"); }}>查看全部</button>
                </div>
              )}
            </>
          )
        ) : reports.length === 0 ? (
          <div className="panel">
            <EmptyState
              title="还没有体检报告"
              description="导入体检 PDF 后，解析任务会自动开始。"
              action={<UploadDialog onComplete={load} />}
            />
          </div>
        ) : (
          <div className="panel table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>年份</th>
                  <th>体检日期</th>
                  <th>体检机构</th>
                  <th>解析模板</th>
                  <th>页数</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id}>
                    <td><Link className="link mono" href={`/reports/detail?id=${report.id}`}>{report.year || "-"}</Link></td>
                    <td className="mono">{report.exam_date || "待识别"}</td>
                    <td>{report.institution || "未识别机构"}</td>
                    <td>{templateLabels[report.template_type] || report.template_type}</td>
                    <td className="mono">{report.page_count || "-"}</td>
                    <td>
                      <span className={`status ${report.parse_status === "completed" ? "status-normal" : report.parse_status === "failed" ? "status-abnormal" : "status-attention"}`}>
                        <span className="status-symbol" aria-hidden="true" />
                        {parseLabels[report.parse_status] || report.parse_status}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        <Link className="button button-icon" href={`/reports/detail?id=${report.id}`} title="打开报告" aria-label="打开报告"><FilePdf /></Link>
                        <button className="button button-icon" title="重新解析" aria-label="重新解析" onClick={() => void reparse(report)}><ArrowClockwise /></button>
                        <button className="button button-icon button-danger" title="删除报告" aria-label="删除报告" onClick={() => setPendingDelete(report)}><Trash /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`删除 ${pendingDelete?.year || "未知年份"} 年体检报告？`}
        description="将永久移除该份体检报告及其全部解析指标和结论，此操作无法撤销。"
        confirmLabel="确认删除"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<div className="panel skeleton" style={{ height: 320 }} />}>
      <ReportsView />
    </Suspense>
  );
}
