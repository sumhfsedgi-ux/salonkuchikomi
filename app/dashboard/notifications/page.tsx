import { createClient } from "@/lib/supabase/server";
import { requireFeatureAccess } from "@/lib/access/featureAccess";
import { listLineConnections } from "@/lib/notifications/db/lineConnections";
import { getNotificationSettings } from "@/lib/notifications/db/notificationSettings";
import { listRecentDeliveries } from "@/lib/notifications/db/notificationDeliveries";
import { isSalonLockedForCutover, listPendingInvites, listRecipients } from "@/lib/notifications/recipients/db";
import { isLineInviteAvailable } from "@/lib/notifications/line/login/config";
import { isRealLineSendAllowed, resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";
import { loadSetupContext } from "@/lib/features/setupContext";
import { resolveFeatureStates } from "@/lib/features/featureState";
import { getSupportContact } from "@/lib/support/contact";
import PageHeader from "@/components/ui/PageHeader";
import ConnectionStatusCards from "@/components/notifications/ConnectionStatusCards";
import NotificationSettingsPanel from "@/components/notifications/NotificationSettingsPanel";
import RecipientsPanel from "@/components/notifications/RecipientsPanel";
import TestNotifyButton from "@/components/notifications/TestNotifyButton";
import RecentNotificationsList from "@/components/notifications/RecentNotificationsList";

// 保存直後・テスト送信直後の内容を必ず反映する必要があるため、静的プリレンダリングは行わない。
export const dynamic = "force-dynamic";

export default async function DashboardNotificationsPage() {
  const supabase = await createClient();
  const salon = await requireFeatureAccess(supabase, "notifications");

  const [setupContext, allConnections, activeConnections, recipients, invites, locked, settings, deliveries] = await Promise.all([
    loadSetupContext(salon),
    listLineConnections(salon.id, { includeRemoved: true }),
    listLineConnections(salon.id),
    listRecipients(salon.id),
    listPendingInvites(salon.id),
    isSalonLockedForCutover(salon.id),
    getNotificationSettings(salon.id),
    listRecentDeliveries(salon.id),
  ]);
  const reservation = resolveFeatureStates(setupContext).states.find((s) => s.key === "reservation_notifications")!;
  // テスト通知の送り先(sendTestNotificationAction と同じ条件: 解除していない・接続済み)。
  const connectedRecipients = activeConnections.filter((c) => c.status === "connected" && c.destinationId);
  const canSendTest = connectedRecipients.length > 0;
  const sendPolicy = resolveLineSendPolicy();
  const realRecipientCount = connectedRecipients.filter((c) => isRealLineSendAllowed(sendPolicy, c.destinationId!)).length;
  const supportContact = getSupportContact();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="予約通知" description="Hot Pepperの予約をLINEで自動通知します。" />

      <ConnectionStatusCards
        reservation={reservation}
        gmail={setupContext.gmail}
        lineRecipientCount={setupContext.lineRecipientCount}
        supportContact={supportContact}
      />

      <NotificationSettingsPanel initialMasterEnabled={settings.masterEnabled} locked={locked} supportContact={supportContact} />

      <RecipientsPanel recipients={recipients} invites={invites} invitesAvailable={isLineInviteAvailable()} supportContact={supportContact} />

      <div className="flex flex-col gap-1">
        <TestNotifyButton disabled={!canSendTest} mode={sendPolicy.mode} realRecipientCount={realRecipientCount} />
        <p className="text-xs text-ink-muted">
          テスト通知はLINEとの接続の確認だけです。予約メールの検知から通知までの動作確認にはなりません。
        </p>
      </div>

      <RecentNotificationsList deliveries={deliveries} recipients={allConnections} />
    </div>
  );
}
