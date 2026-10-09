"use client";

import {
  ChartLineUp,
  CursorClick,
  Stack,
  WarningCircle,
  X,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiFetch, withProfile } from "@/lib/api";
import type {
  DashboardData,
  HealthStatus,
  RiskDetail,
  RiskDomain,
} from "@/lib/types";

const statusLabels: Record<HealthStatus, string> = {
  normal: "正常",
  attention: "关注",
  abnormal: "异常",
  insufficient: "无数据",
};

function cellCount(
  status: HealthStatus,
  abnormal: number,
  attention: number,
): string {
  if (status === "abnormal") return String(abnormal);
  if (status === "attention") return String(attention);
  if (status === "normal") return "0";
  return "—";
}

export function RiskAtlas({
  years,
  rows,
  profileId,
}: {
  years: DashboardData["years"];
  rows: RiskDomain[];
  profileId: string | null;
}) {
  const latestYear = years.at(-1)?.year;
  const latestCells = rows
    .map((row) => row.years.find((cell) => cell.year === latestYear))
    .filter(Boolean);
  const currentRiskCount = latestCells.reduce(
    (sum, cell) => sum + (cell?.abnormal_count || 0),
    0,
  );
  const currentSystems = latestCells.filter(
    (cell) => cell?.status === "abnormal" || cell?.status === "attention",
  ).length;
  const peakYear = years.reduce((peak, item) => {
    const score = item.abnormal_count * 3 + item.attention_count;
    const peakScore = peak.abnormal_count * 3 + peak.attention_count;
    return score > peakScore ? item : peak;
  }, years[0]);

  const [selected, setSelected] = useState<{
    domainId: string;
    year: number;
  } | null>(null);
  const [detail, setDetail] = useState<RiskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!selected || !profileId) return;
    const request = ++requestVersion.current;
    setLoading(true);
    setError("");
    setDetail(null);
    apiFetch<RiskDetail>(
      withProfile(
        `/dashboard/risk-detail?domain_id=${selected.domainId}&year=${selected.year}`,
        profileId,
      ),
    )
      .then((data) => {
        if (request === requestVersion.current) setDetail(data);
      })
      .catch((reason) => {
        if (request === requestVersion.current)
          setError(
            reason instanceof Error ? reason.message : "无法加载风险明细",
          );
      })
      .finally(() => {
        if (request === requestVersion.current) setLoading(false);
      });
  }, [selected, profileId]);

  const clearSelection = () => setSelected(null);

  return (
    <div className="risk-atlas">
      <div className="risk-atlas-heading">
        <div>
          <h2 className="section-title">年度健康轨迹 · 风险图谱</h2>
          <p>
            按系统汇总历年可信异常证据；数字为去重后的风险数量，点击可查看明细。
          </p>
        </div>
        <div className="risk-atlas-legend" aria-label="风险图谱图例">
          {(["normal", "attention", "abnormal", "insufficient"] as const).map(
            (status) => (
              <span key={status} className={`tone-${status}`}>
                <i aria-hidden="true" />
                {statusLabels[status]}
              </span>
            ),
          )}
        </div>
      </div>
      <div className="risk-atlas-summary">
        <div>
          <WarningCircle aria-hidden="true" />
          <span>
            当前异常<strong className="mono">{currentRiskCount}</strong>
            <small>项风险</small>
          </span>
        </div>
        <div>
          <Stack aria-hidden="true" />
          <span>
            涉及系统<strong className="mono">{currentSystems}</strong>
            <small>个系统</small>
          </span>
        </div>
        <div>
          <ChartLineUp aria-hidden="true" />
          <span>
            风险峰值<strong className="mono">{peakYear?.year || "—"}</strong>
            <small>异常最集中</small>
          </span>
        </div>
      </div>
      <div className="risk-atlas-main">
        <div className="risk-atlas-scroll">
          <table className="risk-atlas-table">
            <thead>
              <tr>
                <th>系统 / 年份</th>
                {years.map((item) => (
                  <th
                    key={item.year}
                    className={item.year === latestYear ? "latest" : ""}
                  >
                    <span>{item.year}</span>
                    {item.year === latestYear && <small>最新</small>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th>{row.label}</th>
                  {years.map((year) => {
                    const cell = row.years.find(
                      (item) => item.year === year.year,
                    );
                    const status = cell?.status || "insufficient";
                    const count = cellCount(
                      status,
                      cell?.abnormal_count || 0,
                      cell?.attention_count || 0,
                    );
                    const risky =
                      (cell?.abnormal_count || 0) +
                        (cell?.attention_count || 0) >
                      0;
                    const isSelected =
                      selected?.domainId === row.id &&
                      selected?.year === year.year;
                    const title = `${row.label} ${year.year}：${statusLabels[status]}，异常 ${cell?.abnormal_count || 0} 项，关注 ${cell?.attention_count || 0} 项`;
                    const cellClass = `risk-cell tone-${status}${isSelected ? " selected" : ""}`;
                    return (
                      <td
                        key={year.year}
                        className={year.year === latestYear ? "latest" : ""}
                      >
                        {risky ? (
                          <button
                            type="button"
                            className={cellClass}
                            title={title}
                            aria-label={`${row.label}${year.year}年${statusLabels[status]}${count}项，点击查看明细`}
                            aria-pressed={isSelected}
                            onClick={() =>
                              setSelected(
                                isSelected
                                  ? null
                                  : { domainId: row.id, year: year.year },
                              )
                            }
                          >
                            <strong className="mono">{count}</strong>
                          </button>
                        ) : (
                          <span
                            className={cellClass}
                            title={title}
                            aria-label={`${row.label}${year.year}年${statusLabels[status]}${count}项`}
                          >
                            <strong className="mono">{count}</strong>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="risk-detail" aria-live="polite">
          {selected ? (
            loading ? (
              <div className="skeleton risk-detail-skeleton" />
            ) : error ? (
              <div className="risk-detail-error">
                <p>{error}</p>
                <button
                  type="button"
                  className="link"
                  onClick={() => setSelected({ ...selected })}
                >
                  重试
                </button>
              </div>
            ) : detail ? (
              <>
                <div className="risk-detail-head">
                  <h3>{detail.label}</h3>
                  <span className="mono">{detail.year} 年</span>
                  <button
                    type="button"
                    className="risk-detail-close"
                    aria-label="关闭风险明细"
                    onClick={clearSelection}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="risk-detail-counts">
                  <span className="tone-abnormal">
                    异常 {detail.abnormal_count}
                  </span>
                  <span className="tone-attention">
                    关注 {detail.attention_count}
                  </span>
                </div>
                <div className="risk-detail-list">
                  {detail.evidence.length === 0 ? (
                    <div className="risk-detail-nothing">
                      这一年的证据数量为 0，没有可展示的风险明细。
                    </div>
                  ) : (
                    detail.evidence.map((item, index) => (
                      <div
                        className="risk-detail-row"
                        key={`${item.report_id}-${item.kind}-${index}`}
                      >
                        <div className="risk-detail-headline">
                          <strong>{item.title}</strong>
                          <StatusBadge status={item.status} compact />
                        </div>
                        <div
                          className={
                            item.kind === "finding"
                              ? "risk-detail-copy"
                              : "risk-detail-copy mono"
                          }
                        >
                          {item.value || "—"}
                        </div>
                        <div className="risk-detail-meta">
                          {item.reference && (
                            <span className="muted mono">{item.reference}</span>
                          )}
                          <small>{item.status_reason}</small>
                          <Link
                            className="link"
                            href={`/reports/detail?id=${item.report_id}`}
                          >
                            第 {item.page} 页
                          </Link>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : null
          ) : (
            <div className="risk-detail-empty">
              <CursorClick aria-hidden="true" />
              <p>
                点击表格中有风险的年份数字，
                <br />
                查看对应的异常指标与报告结论。
              </p>
            </div>
          )}
        </aside>
      </div>
      <p className="risk-atlas-note">
        数量来自体检报告中的异常指标与结论证据，仅用于健康管理，不构成医学诊断。
      </p>
    </div>
  );
}
