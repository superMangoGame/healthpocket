"use client";

import { useId } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendSeries } from "@/lib/types";

export function DashboardTrend({ series }: { series: TrendSeries | null }) {
  const gradientId = useId();
  const data = series?.points.map((point) => ({
    year: point.exam_date ?? String(point.year),
    value: point.value_numeric,
    low: point.ref_low,
    high: point.ref_high,
  })) || [];
  if (!data.length) {
    return (
      <div className="empty-state" style={{ minHeight: 240 }}>
        <p>导入体检报告后，这里会显示关键指标的年度走势。</p>
      </div>
    );
  }
  return (
    <div className="chart-wrap" aria-label={`${series?.display_name}年度趋势图`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 18, right: 16, bottom: 4, left: -14 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--line)" vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="year" tick={{ fill: "var(--muted)", fontSize: 11.5 }} axisLine={{ stroke: "var(--line)" }} tickLine={false} />
          <YAxis tick={{ fill: "var(--muted)", fontSize: 11.5 }} axisLine={false} tickLine={false} />
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
            formatter={(val, name) => [val, name === "value" ? (series?.display_name ?? "数值") : "参考上限"]}
          />
          <Area type="monotone" dataKey="value" stroke="none" fill={`url(#${gradientId})`} connectNulls={false} />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--accent)"
            strokeWidth={2.5}
            dot={{ r: 4, fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }}
            activeDot={{ r: 6, fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
