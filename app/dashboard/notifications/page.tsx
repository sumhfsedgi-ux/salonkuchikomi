import ComingSoon from "@/components/dashboard/ComingSoon";
import { BellIcon } from "@/components/ui/icons";

// Intentionally static -- no Supabase query, no fetch, and no connection to
// hmail (the currently-live, production LINE notification system) in any
// way. That system keeps running completely untouched by this app.
export default function DashboardNotificationsPage() {
  return (
    <ComingSoon
      icon={BellIcon}
      title="予約通知"
      pageDescription="予約をLINEで自動通知"
      bodyText="予約LINE通知機能は近日公開予定です。公開までしばらくお待ちください。"
    />
  );
}
