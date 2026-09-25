import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { getMailConnection } from "@/lib/notifications/db/mailConnections";
import { listLineConnections } from "@/lib/notifications/db/lineConnections";
import { getNotificationSettings } from "@/lib/notifications/db/notificationSettings";
import { listRecentHistory } from "@/lib/notifications/db/notificationHistory";
import PageHeader from "@/components/ui/PageHeader";
import ConnectionStatusCards from "@/components/notifications/ConnectionStatusCards";
import NotificationSettingsPanel from "@/components/notifications/NotificationSettingsPanel";
import TestNotifyButton from "@/components/notifications/TestNotifyButton";
import RecentNotificationsList from "@/components/notifications/RecentNotificationsList";

// 保存直後・テスト送信直後の内容を必ず反映する必要があるため、静的プリレンダリングは行わない。
export const dynamic = "force-dynamic";

export default async function DashboardNotificationsPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  const [mailConnection, lineConnections, settings, history] = await Promise.all([
    getMailConnection(salon.id),
    listLineConnections(salon.id),
    getNotificationSettings(salon.id),
    listRecentHistory(salon.id),
  ]);

  const canSendTest = lineConnections.some((c) => c.status === "connected");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="予約通知" description="Hot Pepperの予約をLINEで自動通知します。" />

      <ConnectionStatusCards mailConnection={mailConnection} lineConnections={lineConnections} />

      <NotificationSettingsPanel initialMasterEnabled={settings.masterEnabled} recipients={lineConnections} />

      <TestNotifyButton disabled={!canSendTest} />

      <RecentNotificationsList history={history} recipients={lineConnections} />
    </div>
  );
}
