import { Check, Minus, Warning } from "@phosphor-icons/react/dist/ssr";
import type { HealthStatus } from "@/lib/types";

const labels: Record<HealthStatus, string> = { normal: "正常", attention: "关注", abnormal: "异常", insufficient: "数据不足" };

export function YearTimeline({ years }: { years: Array<{ year: number; status: HealthStatus }> }) {
  const icon = (status: HealthStatus) => status === "normal" ? <Check size={16} weight="bold" /> : status === "insufficient" ? <Minus size={15} /> : <Warning size={15} weight="fill" />;
  return (
    <div className="timeline" aria-label="年度健康状态">
      {years.map((item) => (
        <div key={item.year} className={`timeline-item tone-${item.status}`}>
          <div className="timeline-node" title={`${item.year} ${labels[item.status]}`}>{icon(item.status)}</div>
          <div className="timeline-year mono">{item.year}</div>
          <div className="timeline-label">{labels[item.status]}</div>
        </div>
      ))}
    </div>
  );
}

