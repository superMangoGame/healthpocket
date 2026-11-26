"use client";

import { CalendarCheck, Folders, Stack, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardTrend } from "@/components/DashboardTrend";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { ReportInsightsPanel } from "@/components/ReportInsightsPanel";
import { RiskAtlas } from "@/components/RiskAtlas";
import { UploadDialog } from "@/components/UploadDialog";
import { YearArchive } from "@/components/YearArchive";
import { apiFetch, withProfile } from "@/lib/api";
import { buildTimeline, type TimelineEntry } from "@/lib/records";
import type { DashboardData, MedicalRecord, ReportSummary, TrendSeries } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton" aria-busy="true" aria-label="正在加载健康总览">
      <div className="overview-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel kpi-card skeleton-card">
            <span className="skeleton skeleton-line w-40" />
            <span className="skeleton skeleton-line h-lg w-60" />
            <span className="skeleton skeleton-line w-70" />
          </div>
        ))}
      </div>
      <div className="panel skeleton-panel">
        <span className="skeleton skeleton-line w-35" />
        <span className="skeleton skeleton-block" />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { activeProfile, activeProfileId } = useProfiles();
  const [data, setData] = useState<DashboardData | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [trend, setTrend] = useState<TrendSeries | null>(null);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (!activeProfileId) return;
    const request = ++requestVersion.current;
    setData(null);
    setEntries([]);
    setTrend(null);
    setError("");
    try {
      const [dashboard, reports, records] = await Promise.all([
        apiFetch<DashboardData>(withProfile("/dashboard", activeProfileId)),
        apiFetch<ReportSummary[]>(withProfile("/reports", activeProfileId)),
        apiFetch<MedicalRecord[]>(withProfile("/records", activeProfileId)),
      ]);
      if (request !== requestVersion.current) return;
      setEntries(buildTimeline(reports, records));
      setData(dashboard);
      const candidates = [
        "total_bilirubin",
        "total_cholesterol",
        "triglyceride",
        "glucose",
      ];
      for (const id of candidates) {
        const candidate = await apiFetch<TrendSeries>(
          withProfile(`/metrics/trends?canonical_id=${id}`, activeProfileId),
        );
        if (request !== requestVersion.current) return;
        if (candidate.points.length) {
          setTrend(candidate);
          break;
        }
      }
      setError("");
    } catch (loadError) {
      if (request === requestVersion.current) {
        setError(loadError instanceof Error ? loadError.message : "无法连接本地服务");
      }
    }
  }, [activeProfileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    if (!data || !data.years.length) return null;
    const latestYearObj = data.years.at(-1);
    const latestYear = latestYearObj?.year;
    const latestCells = data.risk_matrix
      .map((row) => row.years.find((cell) => cell.year === latestYear))
      .filter(Boolean);
    const abnormalCount = latestCells.reduce((sum, cell) => sum + (cell?.abnormal_count || 0), 0);
    const attentionCount = latestCells.reduce((sum, cell) => sum + (cell?.attention_count || 0), 0);
    const affectedSystems = latestCells.filter(
      (cell) => cell?.status === "abnormal" || cell?.status === "attention",
    ).length;
    return {
      latestYear,
      latestStatus: latestYearObj?.status ?? "insufficient",
      abnormalCount,
      attentionCount,
      affectedSystems,
      yearSpan: data.years.length,
    };
  }, [data]);

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">健康总览</h1>
          <p className="page-subtitle">
            正在查看 {activeProfile?.name || "当前档案"} 的历年体检变化与就医记录，每项状态均可追溯原始报告。
          </p>
        </div>
        <div className="header-actions">
          <UploadDialog onComplete={load} />
        </div>
      </header>
      {error && <div className="error">{error}，请重新打开健康口袋或检查本地插件状态。</div>}
      {!data ? (
        <DashboardSkeleton />
      ) : data.report_count === 0 && entries.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="还没有导入任何报告"
            description="导入体检 PDF 后，系统会在本机自动解析年份、检验指标、参考区间与异常结论；门诊病历、影像与化验单也可按日期归档。"
            action={<UploadDialog onComplete={load} />}
          />
        </div>
      ) : data.report_count === 0 ? (
        <>
          <div className="notice">导入体检 PDF 报告后，这里将自动生成年度风险图谱、关键指标趋势与 AI 档案解读。</div>
          <YearArchive entries={entries} />
        </>
      ) : (
        <>
          {summary && (
            <section className="overview-kpis" aria-label="核心健康摘要">
              <article className="panel kpi-card">
                <div className="kpi-head">
                  <span className="kpi-label">最近体检</span>
                  <span className="kpi-icon"><CalendarCheck size={17} /></span>
                </div>
                <div className="kpi-value">
                  <strong className="mono">{summary.latestYear ?? "—"}</strong>
                  <small>年度</small>
                </div>
                <div className="kpi-foot">
                  <StatusBadge status={summary.latestStatus} compact />
                </div>
              </article>

              <article className={`panel kpi-card ${summary.abnormalCount > 0 ? "kpi-tone-abnormal" : "kpi-tone-normal"}`}>
                <div className="kpi-head">
                  <span className="kpi-label">当前异常项</span>
                  <span className="kpi-icon"><WarningCircle size={17} /></span>
                </div>
                <div className="kpi-value">
                  <strong className="mono">{summary.abnormalCount}</strong>
                  <small>项风险</small>
                </div>
                <div className="kpi-foot">
                  <span className="muted">另有 {summary.attentionCount} 项需关注</span>
                </div>
              </article>

              <article className="panel kpi-card">
                <div className="kpi-head">
                  <span className="kpi-label">涉及系统</span>
                  <span className="kpi-icon"><Stack size={17} /></span>
                </div>
                <div className="kpi-value">
                  <strong className="mono">{summary.affectedSystems}</strong>
                  <small>个系统</small>
                </div>
                <div className="kpi-foot">
                  <Link href="/body" className="link">在 3D 图谱查看</Link>
                </div>
              </article>

              <article className="panel kpi-card">
                <div className="kpi-head">
                  <span className="kpi-label">累计归档</span>
                  <span className="kpi-icon"><Folders size={17} /></span>
                </div>
                <div className="kpi-value">
                  <strong className="mono">{entries.length}</strong>
                  <small>份记录</small>
                </div>
                <div className="kpi-foot">
                  <span className="muted">覆盖 {summary.yearSpan} 个体检年度</span>
                </div>
              </article>
            </section>
          )}

          <section className="panel dashboard-hero">
            <div className="dashboard-timeline">
              <RiskAtlas
                years={data.years}
                rows={data.risk_matrix}
                profileId={activeProfileId}
              />
            </div>
          </section>

          <YearArchive entries={entries} />
          <ReportInsightsPanel profileId={activeProfileId} />

          <section className="dashboard-grid">
            <div className="panel dashboard-card">
              <div className="panel-header">
                <div>
                  <h2 className="section-title">关键指标趋势</h2>
                  <p className="panel-subtitle">{trend?.display_name || "等待指标数据"}</p>
                </div>
                <Link href="/trends" className="link">完整趋势 →</Link>
              </div>
              <div className="panel-body">
                <DashboardTrend series={trend} />
              </div>
            </div>

            <div className="panel dashboard-card">
              <div className="panel-header">
                <div>
                  <h2 className="section-title">最近体检报告</h2>
                  <p className="panel-subtitle">点击年份直接进入双栏原文对照</p>
                </div>
                <Link href="/reports" className="link">全部报告 →</Link>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>年份</th>
                      <th>机构</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.latest_reports.map((report) => {
                      const yearStatus =
                        data.years.find((item) => item.year === report.year)
                          ?.status || "insufficient";
                      return (
                        <tr key={report.id}>
                          <td>
                            <Link
                              className="link mono"
                              href={`/reports/detail?id=${report.id}`}
                            >
                              {report.year || "-"}
                            </Link>
                          </td>
                          <td>{report.institution || "未识别机构"}</td>
                          <td>
                            <StatusBadge status={yearStatus} compact />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}
