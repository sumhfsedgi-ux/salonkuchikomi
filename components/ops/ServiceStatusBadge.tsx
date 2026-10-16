import Badge from "@/components/ui/Badge";
import { SERVICE_STATUS_LABELS, type ServiceStatus } from "@/lib/onboarding/serviceStatus";

// 利用区分の印(色だけに頼らず、必ず文字で出す)。テスト用は枠線で目立たせる。
export default function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  if (status === "test") {
    return (
      <Badge variant="warning" className="border border-dashed border-warning">
        {SERVICE_STATUS_LABELS.test}
      </Badge>
    );
  }
  return <Badge variant={status === "pending" ? "warning" : "neutral"}>{SERVICE_STATUS_LABELS[status]}</Badge>;
}
