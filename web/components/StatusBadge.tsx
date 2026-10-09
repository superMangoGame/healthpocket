import type { HealthStatus } from "@/lib/types";

const labels: Record<HealthStatus, string> = {
  normal: "正常",
  attention: "关注",
  abnormal: "异常",
  insufficient: "数据不足",
};

export function StatusBadge({ status, compact = false }: { status: HealthStatus; compact?: boolean }) {
  return (
    <span className={`status status-${status} ${compact ? "status-compact" : ""}`}>
      <span className="status-symbol" aria-hidden="true" />
      {labels[status]}
    </span>
  );
}

