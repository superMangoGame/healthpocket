"use client";

import { MagnifyingGlass, TrendDown, TrendUp, X } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { apiFetch, withProfile } from "@/lib/api";
import { evidenceHref, evidenceLink } from "@/lib/records";
import type { MetricDefinition, TrendSeries } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

export function TrendExplorer() {
  const gradientId = useId();
  const { activeProfileId } = useProfiles();
  const [metrics, setMetrics] = useState<MetricDefinition[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [selectedUnit, setSelectedUnit] = useState("");
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [error, setError] = useState("");
  const [metricsLoading, setMetricsLoading] = useState(true);

  useEffect(() => {
    if (!activeProfileId) return;
    let cancelled = false;
    setMetricsLoading(true);
    setMetrics([]);
    setSeries(null);
    setError("");
    apiFetch<MetricDefinition[]>(withProfile("/metrics/definitions", activeProfileId))
      .then((items) => {
        if (cancelled) return;
        setMetrics(items);
        setSelected((current) => items.some((item) => item.canonical_id === current) ? current : items[0]?.canonical_id || "");
        setSelectedUnit("");
      })
      .catch((reason) => { if (!cancelled) setError(reason.message); })
      .finally(() => { if (!cancelled) setMetricsLoading(false); });
    return () => { cancelled = true; };
  }, [activeProfileId]);

  useEffect(() => {
    if (!activeProfileId || !selected || !metrics.some((metric) => metric.canonical_id === selected)) return;
    let cancelled = false;
    setSeries(null);
    setError("");
    const unitQuery = selectedUnit ? `&unit=${encodeURIComponent(selectedUnit)}` : "";
    apiFetch<TrendSeries>(withProfile(`/metrics/trends?canonical_id=${selected}${unitQuery}`, activeProfileId))
      .then((value) => { if (!cancelled) setSeries(value); })
      .catch((reason) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [selected, selectedUnit, activeProfileId, metrics]);

  const filteredMetrics = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return metrics;
    return metrics.filter(
      (item) =>
        item.display_name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.canonical_id.toLowerCase().includes(q),
    );
  }, [metrics, query]);

  const groups = useMemo(() => {
    const map = new Map<string, MetricDefinition[]>();
    for (const metric of filteredMetrics) {
      map.set(metric.category, [...(map.get(metric.category) || []), metric]);
    }
    return map;
  }, [filteredMetrics]);

  const data = series?.points.map((point) => ({
    ...point,
    when: point.exam_date ?? String(point.year),
    refBand: point.ref_low != null && point.ref_high != null ? point.ref_high - point.ref_low : null,
  })) || [];
  const numericPoints = series?.points.filter((point) => point.value_numeric != null) || [];
  const hasNumericValues = numericPoints.length > 0;
  const latest = series?.points.at(-1);
  const prevNumeric = numericPoints.length >= 2 ? numericPoints.at(-2)?.value_numeric ?? null : null;
  const latestNumeric = numericPoints.at(-1)?.value_numeric ?? null;
  const delta = latestNumeric != null && prevNumeric != null
    ? Math.round((latestNumeric - prevNumeric) * 100) / 100
    : null;

  return (
    <div className="trends-layout">
      <aside className="panel metric-nav" aria-label="指标选择">
        <div className="metric-nav-header">
          <strong>可用指标</strong>
          {!metricsLoading && <span className="mono metric-count-badge">{filteredMetrics.length}</span>}
        </div>
        <div className="metric-search">
          <MagnifyingGlass size={15} className="metric-search-icon" aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="搜索指标名或分类…"
            aria-label="搜索指标"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" className="metric-search-clear" aria-label="清空搜索" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="metric-nav-scroll">
          {metricsLoading ? (
            <div className="metric-nav-loading">
              <span className="skeleton" />
              <span className="skeleton" />
              <span className="skeleton" />
            </div>
          ) : groups.size === 0 ? (
            <p className="metric-nav-empty">未找到匹配「{query}」的指标</p>
          ) : (
            [...groups.entries()].map(([category, items]) => (
              <div className="metric-group" key={category}>
                <h3>{category}</h3>
                {items.map((metric) => (
                  <button
                    key={metric.canonical_id}
                    className={`metric-button ${selected === metric.canonical_id ? "active" : ""}`}
                    onClick={() => { setSelected(metric.canonical_id); setSelectedUnit(""); }}
                  >
                    {metric.display_name}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="trend-workspace">
        {error && <div className="error">{error}</div>}
        {!metricsLoading && metrics.length === 0 && !error ? (
          <div className="panel trend-empty-view">
            <span className="mono">0 项</span>
            <h2>当前档案暂无趋势数据</h2>
            <p>导入包含可识别指标和体检年份的报告后，趋势指标会自动出现在这里。</p>
          </div>
        ) : (
          <>
            <div className="panel trend-chart-card">
              <div className="trend-title-row">
                <div>
                  <div className="trend-title-head">
                    <h2>{series?.display_name || "选择指标"}</h2>
                    {latest && <StatusBadge status={latest.confidence < 0.8 ? "insufficient" : latest.status} />}
                  </div>
                  <p className="muted trend-subtitle">
                    {series?.category || "—"} · 单位按原报告保存{latest?.ref_text ? ` · 参考 ${latest.ref_text}` : ""}
                  </p>
                </div>
                <div className="trend-latest-block">
                  {series && series.available_units.length > 1 && (
                    <select
                      className="select mono"
                      aria-label="选择单位序列"
                      value={series.selected_unit || ""}
                      onChange={(event) => setSelectedUnit(event.target.value)}
                    >
                      {series.available_units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                    </select>
                  )}
                  {latest && (
                    <div className="trend-latest-metric">
                      <div className="trend-latest-val">
                        <strong className="mono">{latest.value_numeric ?? latest.value_text}</strong>
                        <small>{latest.unit}</small>
                      </div>
                      <div className="trend-latest-meta">
                        <span className="muted mono">{latest.exam_date ?? `${latest.year} 年`}</span>
                        {delta !== null && delta !== 0 && (
                          <span className={`trend-delta ${delta > 0 ? "up" : "down"}`}>
                            {delta > 0 ? <TrendUp size={13} /> : <TrendDown size={13} />}
                            {delta > 0 ? `+${delta}` : delta}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="trend-chart-panel">
                {!data.length ? (
                  <div className="empty-state" style={{ minHeight: 320 }}>
                    <p>这个指标尚无可信数据。</p>
                  </div>
                ) : !hasNumericValues ? (
                  <div className="categorical-trend" aria-label={`${series?.display_name || "分类指标"}历年结果`}>
                    {series?.points.map((point) => (
                      <div className="categorical-trend-item" key={`${point.report_id}-${point.file_id ?? ""}-${point.year}`}>
                        <span className="mono categorical-trend-year">{point.exam_date ?? point.year}</span>
                        <span className={`categorical-trend-node tone-${point.status}`} aria-hidden="true" />
                        <strong>{point.value_text || "未记录结果"}</strong>
                        <StatusBadge status={point.confidence < 0.8 ? "insufficient" : point.status} compact />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="chart-wrap" style={{ height: 370 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={data} margin={{ top: 20, right: 20, bottom: 8, left: -8 }}>
                        <defs>
                          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
                            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.01} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--line)" vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="when" tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={{ stroke: "var(--line)" }} tickLine={false} />
                        <YAxis tick={{ fill: "var(--muted)", fontSize: 11.5 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
                        <Tooltip
                          contentStyle={{
                            background: "var(--surface)",
                            border: "1px solid var(--line-strong)",
                            borderRadius: 10,
                            fontSize: 12.5,
                            color: "var(--text)",
                            boxShadow: "var(--shadow)",
                          }}
                          labelStyle={{ color: "var(--muted)", marginBottom: 4 }}
                          formatter={(value, name) => name === "value_numeric" ? [value, series?.display_name] : [value, "参考范围"]}
                        />
                        <Area type="linear" dataKey="ref_low" stackId="range" stroke="none" fill="transparent" connectNulls={false} />
                        <Area type="linear" dataKey="refBand" stackId="range" stroke="none" fill="var(--accent-soft)" fillOpacity={0.75} connectNulls={false} />
                        <Area type="monotone" dataKey="value_numeric" stroke="none" fill={`url(#${gradientId})`} connectNulls={false} />
                        <Line
                          type="monotone"
                          dataKey="value_numeric"
                          stroke="var(--accent)"
                          strokeWidth={2.5}
                          connectNulls={false}
                          activeDot={{ r: 6.5, fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }}
                          dot={(props) => {
                            const item = data[props.index];
                            const color = item?.status === "abnormal" ? "var(--abnormal)" : item?.status === "attention" ? "var(--attention)" : "var(--accent)";
                            return <circle key={props.key} cx={props.cx} cy={props.cy} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} />;
                          }}
                        />
                        {latest?.ref_high != null && <ReferenceLine y={latest.ref_high} stroke="var(--line-strong)" strokeDasharray="4 4" />}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>

            <section className="section">
              <div className="section-head">
                <h3 className="section-title">来源证据</h3>
                {series && series.points.length > 0 && <span className="muted mono">已记录 {series.points.length} 次</span>}
              </div>
              <div className="panel table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>检测结果</th>
                      <th>参考范围</th>
                      <th>状态</th>
                      <th>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series?.points.map((point) => (
                      <tr key={`${point.report_id}-${point.file_id ?? ""}-${point.year}`}>
                        <td className="mono">{point.exam_date ?? point.year}</td>
                        <td className="mono"><strong>{point.value_numeric ?? point.value_text}</strong> {point.unit}</td>
                        <td className="mono">{point.ref_text || "无"}</td>
                        <td><StatusBadge status={point.confidence < 0.8 ? "insufficient" : point.status} compact /></td>
                        <td>
                          <Link className="link" href={evidenceHref(point)}>
                            {point.origin === "record" ? evidenceLink(point) : `体检报告 第 ${point.page} 页`}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
