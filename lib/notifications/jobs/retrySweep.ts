import { listRetryableFailures, markRetryOutcome } from "@/lib/notifications/db/notificationHistory";
import type { LineConnection } from "@/lib/notifications/db/lineConnections";

// (hmailの lib/jobs/retrySweep.ts を移植。1店舗に複数のLINE送信先(スタッフ)を
// 持てるようにしたため、失敗履歴のline_connection_idからどの送信先へ再送する
// かを解決する -- PLAN 11b節参照。)

/**
 * 直近の失敗したLINE送信(例: 一時的なLINE側の障害)を、上限回数まで
 * 再試行する。processed_emails/クレームには一切触れないため、二重送信を
 * 引き起こしようがない -- 既に一意にクレームされ整形済みの、配信だけが
 * 失敗したメッセージを再送するだけ。
 *
 * line_connection_idがnull(そもそも送信先が1件も無かった)、または現在の
 * recipients一覧に見つからない(その後に削除された等)行は、再送のしようが
 * ないためスキップする。
 */
export async function retrySweep(
  salonId: string,
  recipients: LineConnection[],
  sendLine: (destinationId: string, text: string) => Promise<void>,
  dryRun = false
): Promise<void> {
  const destinationById = new Map(
    recipients.filter((r) => r.status === "connected" && r.destinationId).map((r) => [r.id, r.destinationId!])
  );
  if (destinationById.size === 0) return;

  const failures = await listRetryableFailures(salonId);
  for (const failure of failures) {
    if (!failure.lineText || !failure.lineConnectionId) continue;
    const destinationId = destinationById.get(failure.lineConnectionId);
    if (!destinationId) continue;

    if (dryRun) {
      console.info(`[notifications dry-run] would retry notification_history id=${failure.id}`);
      continue;
    }
    try {
      await sendLine(destinationId, failure.lineText);
      await markRetryOutcome(failure.id, { status: "sent" });
    } catch {
      await markRetryOutcome(failure.id, { status: "failed", errorMessage: "LINEへの通知送信に失敗しました" });
    }
  }
}
