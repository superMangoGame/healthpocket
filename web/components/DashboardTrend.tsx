"use client";

import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendSeries } from "@/lib/types";

export function DashboardTrend({ series }: { series: TrendSeries | null }) {
  const data = series?.points.map((point) => ({
    year: point.year,
    value: point.value_numeric,
    low: point.ref_low,
    high: point.ref_high,
  })) || [];
  if (!data.length) return <div className="empty-state" style={{ minHeight: 280 }}><p>导入报告后，这里会显示关键指标趋势。</p></div>;
  return (
    <div className="chart-wrap" aria-label={`${series?.display_name}年度趋势图`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 20, right: 14, bottom: 4, left: -16 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="year" tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={{ stroke: "var(--line)" }} tickLine={false} />
          <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }} />
          <Area type="monotone" dataKey="high" stroke="none" fill="var(--accent-soft)" fillOpacity={0.5} connectNulls={false} />
          <Line type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2.2} dot={{ r: 4, fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

