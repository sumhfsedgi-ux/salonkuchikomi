import { listActiveMailConnections, decryptRefreshToken } from "@/lib/notifications/db/mailConnections";
import { listLineConnections } from "@/lib/notifications/db/lineConnections";
import { getNotificationSettings } from "@/lib/notifications/db/notificationSettings";
import { startCronRun, finishCronRun } from "@/lib/notifications/db/cronRuns";
import { GmailProvider } from "@/lib/notifications/mail/GmailProvider";
import { pushText } from "@/lib/notifications/line/LineClient";
import { pollMailForSalon, type PollResult } from "@/lib/notifications/jobs/pollMailForSalon";
import { retrySweep } from "@/lib/notifications/jobs/retrySweep";

// (hmailの lib/jobs/pollMailForAllSalons.ts を移植)

export interface CronSummary {
  salonsProcessed: number;
  salonsFailed: number;
  dryRun?: boolean;
  dryRunResults?: Array<{ salonId: string; result: PollResult }>;
}

/**
 * 外部スケジューラから呼ばれるエントリポイント。有効(または直近まで壊れて
 * いた)メール接続を持つ全サロンを順に処理する。1サロンの失敗が他へ波及
 * しないよう、pollMailForSalon/retrySweep内部で既にエラーを握りつぶして
 * いることに加え、このループ自体にももう一段の分離を入れている。
 *
 * dryRun=true のときは、本番の processed_emails へのクレームも
 * notification_history への書き込みも実際のLINE送信も行わず、cron_runsの
 * 記録も残さない(本番の状態を一切変更しない検証専用の実行)。
 */
export async function pollMailForAllSalons(dryRun = false): Promise<CronSummary> {
  const connections = await listActiveMailConnections();
  const runId = dryRun ? null : await startCronRun();

  let salonsProcessed = 0;
  let salonsFailed = 0;
  const dryRunResults: Array<{ salonId: string; result: PollResult }> = [];

  for (const connection of connections) {
    try {
      const refreshToken = decryptRefreshToken(connection);
      const mailProvider = new GmailProvider(refreshToken, new Date(connection.createdAt));
      const [recipients, settings] = await Promise.all([
        listLineConnections(connection.salonId),
        getNotificationSettings(connection.salonId),
      ]);

      await retrySweep(connection.salonId, recipients, pushText, dryRun);
      const result = await pollMailForSalon(connection.salonId, {
        mailProvider,
        masterEnabled: settings.masterEnabled,
        recipients,
        sendLine: pushText,
        dryRun,
      });
      if (dryRun) dryRunResults.push({ salonId: connection.salonId, result });
      salonsProcessed++;
    } catch {
      salonsFailed++;
    }
  }

  if (runId) await finishCronRun(runId, { salonsProcessed, salonsFailed });

  return dryRun
    ? { salonsProcessed, salonsFailed, dryRun: true, dryRunResults }
    : { salonsProcessed, salonsFailed };
}
