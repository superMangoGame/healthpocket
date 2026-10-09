import { TrendExplorer } from "@/components/TrendExplorer";

export default function TrendsPage() {
  return (
    <>
      <header className="page-header">
        <div><h1 className="page-title">指标趋势</h1><p className="page-subtitle">只比较单位兼容的原始结果；缺失年份保持空白，不进行插值。</p></div>
      </header>
      <TrendExplorer />
    </>
  );
}

