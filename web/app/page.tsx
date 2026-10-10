"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardTrend } from "@/components/DashboardTrend";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { ReportInsightsPanel } from "@/components/ReportInsightsPanel";
import { RiskAtlas } from "@/components/RiskAtlas";
import { UploadDialog } from "@/components/UploadDialog";
import { apiFetch, withProfile } from "@/lib/api";
import type { DashboardData, TrendSeries } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

export default function DashboardPage() {
  const { activeProfile, activeProfileId } = useProfiles();
  const [data, setData] = useState<DashboardData | null>(null);
  const [trend, setTrend] = useState<TrendSeries | null>(null);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    if (!activeProfileId) return;
    const request = ++requestVersion.current;
    setData(null);
    setTrend(null);
    setError("");
    try {
      const dashboard = await apiFetch<DashboardData>(
        withProfile("/dashboard", activeProfileId),
      );
      if (request !== requestVersion.current) return;
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
      if (request === requestVersion.current)
        setError(
          loadError instanceof Error ? loadError.message : "无法连接本地服务",
        );
    }
  }, [activeProfileId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">健康总览</h1>
          <p className="page-subtitle">
            正在查看 {activeProfile?.name || "当前档案"}{" "}
            的体检变化，每一个状态都能追溯到原始报告。
          </p>
        </div>
        <div className="header-actions">
          <UploadDialog onComplete={load} />
        </div>
      </header>
      {error && <div className="error">{error}。请先启动 FastAPI 服务。</div>}
      {!data ? (
        <div className="panel skeleton" style={{ height: 340 }} />
      ) : data.report_count === 0 ? (
        <div className="panel">
          <EmptyState
            title="还没有体检报告"
            description="导入第一份 PDF 后，系统会自动识别年份、指标、参考区间和报告结论。"
            action={<UploadDialog onComplete={load} />}
          />
        </div>
      ) : (
        <>
          <section className="panel dashboard-hero">
            <div className="dashboard-timeline">
              <RiskAtlas
                years={data.years}
                rows={data.risk_matrix}
                profileId={activeProfileId}
              />
            </div>
          </section>
          <ReportInsightsPanel profileId={activeProfileId} />
          <section className="dashboard-grid">
            <div>
              <div className="section-head">
                <div>
                  <h2 className="section-title">关键指标趋势</h2>
                  <p
                    className="muted"
                    style={{ margin: "6px 0 0", fontSize: 12 }}
                  >
                    {trend?.display_name || "等待指标"}
                  </p>
                </div>
                <Link href="/trends" className="link">
                  完整趋势
                </Link>
              </div>
              <div className="panel panel-body">
                <DashboardTrend series={trend} />
              </div>
            </div>
            <div>
              <div className="section-head">
                <h2 className="section-title">最近报告</h2>
                <Link href="/reports" className="link">
                  报告库
                </Link>
              </div>
              <div className="panel table-scroll">
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
