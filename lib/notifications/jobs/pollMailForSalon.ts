import { claimMessageForProcessing, recordEventType } from "@/lib/notifications/db/processedEmails";
import { recordNotification } from "@/lib/notifications/db/notificationHistory";
import { isEventTypeEnabledForConnection, type LineConnection } from "@/lib/notifications/db/lineConnections";
import { recordMailAuthFailure, recordMailCheckSuccess } from "@/lib/notifications/db/mailConnections";
import { detectEmail } from "@/lib/notifications/hotpepper/detectEmail";
import { parseReservation } from "@/lib/notifications/hotpepper/parseReservation";
import { formatLineMessage } from "@/lib/notifications/hotpepper/formatLineMessage";
import { MailConnectionInvalidError, type MailProvider } from "@/lib/notifications/mail/MailProvider";

// (hmailの lib/jobs/pollMailForSalon.ts を移植。dryRunモードに加え、1店舗に
// 複数のLINE送信先(スタッフ)を持てるようにしたためfan-out送信に対応した
// -- PLAN 11b節参照。Gmail取得・重複判定・パース・通知文組み立ては店舗につき
// 1回だけ行い、その結果を全送信先へ独立して配信する。)

async function alertOwnerOfBrokenConnection(
  recipients: LineConnection[],
  sendLine: PollDependencies["sendLine"]
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const link = appUrl ? `${appUrl}/dashboard/notifications` : "SalonPackの予約通知画面";
  const text = `予約メールとの接続が切れました。\n\nお手数ですが、${link}から再接続をお願いします。`;
  // ベストエフォート: 誰か1人にでも伝わればよい。1人への送信失敗が他の
  // 送信先への通知を妨げてはいけない。
  await Promise.allSettled(
    recipients
      .filter((r) => r.status === "connected" && r.destinationId)
      .map((r) => sendLine(r.destinationId!, text))
  );
}

export interface PollDependencies {
  mailProvider: MailProvider;
  /** 店舗全体のマスタースイッチ。falseなら候補メールの分類までは行うが誰へも送らない。 */
  masterEnabled: boolean;
  /** この店舗に紐づく全LINE送信先(接続状態・スタッフごとのトグルを含む)。 */
  recipients: LineConnection[];
  sendLine: (destinationId: string, text: string) => Promise<void>;
  /**
   * true のとき、processed_emailsへのクレーム(INSERT)・notification_historyへの
   * 書き込み・実際のLINE送信の3つを完全にスキップする(本番の重複防止状態を
   * 変更しない読み取り中心の検証モード)。Gmail一覧取得・本文取得・分類・
   * パース・通知文の組み立てまでは通常通り行い、結果を dryRunDetails に積む。
   */
  dryRun?: boolean;
}

export interface PollResult {
  candidates: number;
  claimed: number;
  notified: number;
  dryRunDetails?: Array<{
    messageId: string;
    isHotPepper: boolean;
    eventType: string;
    wouldNotify: boolean;
    recipientCount?: number;
    previewText?: string;
  }>;
}

/**
 * 1サロン分の、1回のcron tickにおける予約メール候補を処理する。
 *
 * 二重送信対策: 各候補メッセージは本文取得より前に
 * claimMessageForProcessing()(unique(salon_id, provider_message_id)への
 * INSERT ... ON CONFLICT DO NOTHING)で原子的にクレームする。同時実行が
 * 同じメッセージで競合しても、勝った側だけがそのまま処理を続け、負けた側は
 * 即座にスキップするため、同じメールへのLINE送信が二重に起きることは
 * 構造的にあり得ない。クレームは店舗につき1回だけ行い、そこから全送信先へ
 * fan-outする(スタッフの人数だけ重複してGmailを読み直すことはしない)。
 *
 * fan-out送信の分離: 各送信先への送信は独立したtry/catchで行い、1人への
 * 送信失敗が他のスタッフへの送信を妨げない(Promise.allSettledで並行実行)。
 *
 * エラー分離: 1候補メッセージの処理失敗はこのサロンの残りの処理を止めない
 * (下記のメッセージ単位try/catch参照)。メール接続自体が壊れている場合は
 * 例外を投げず記録するだけにし、呼び出し元(pollMailForAllSalons)は
 * 無条件に次のサロンへ進める。
 */
export async function pollMailForSalon(salonId: string, deps: PollDependencies): Promise<PollResult> {
  const result: PollResult = { candidates: 0, claimed: 0, notified: 0 };
  if (deps.dryRun) result.dryRunDetails = [];

  let candidateIds: string[];
  try {
    candidateIds = await deps.mailProvider.listCandidateMessageIds();
  } catch (error) {
    if (error instanceof MailConnectionInvalidError) {
      if (!deps.dryRun) {
        const justBroke = await recordMailAuthFailure(salonId, error.message);
        if (justBroke) await alertOwnerOfBrokenConnection(deps.recipients, deps.sendLine);
      }
      return result;
    }
    throw error;
  }
  result.candidates = candidateIds.length;

  const connectedRecipients = deps.recipients.filter((r) => r.status === "connected" && r.destinationId);

  for (const messageId of candidateIds) {
    let claimedId: string | null = null;
    if (!deps.dryRun) {
      claimedId = await claimMessageForProcessing(salonId, messageId);
      if (!claimedId) continue; // 既にこのメッセージは処理済み(このtickか、重なった別tickで)。
      result.claimed++;
    }

    try {
      const email = await deps.mailProvider.getMessage(messageId);
      const detection = detectEmail(email);
      if (!deps.dryRun && claimedId) {
        await recordEventType(claimedId, detection.eventType);
      }

      // Hot Pepperのメールではない -- notification_historyには何も残さず
      // (dryRunでない場合)、「最近の通知」一覧をノイズで汚さない。
      if (!detection.isHotPepper) {
        result.dryRunDetails?.push({ messageId, isHotPepper: false, eventType: detection.eventType, wouldNotify: false });
        continue;
      }

      // 店舗全体のマスタースイッチが止まっていれば、誰へも送らない(店舗単位で
      // 1行だけ記録する -- どの送信先向けでもないためline_connection_idはnull)。
      if (!deps.masterEnabled) {
        if (!deps.dryRun) {
          await recordNotification({
            salonId,
            eventType: detection.eventType,
            providerMessageId: messageId,
            status: "skipped_disabled",
          });
        }
        result.dryRunDetails?.push({ messageId, isHotPepper: true, eventType: detection.eventType, wouldNotify: false });
        continue;
      }

      const targets = connectedRecipients.filter((r) => isEventTypeEnabledForConnection(r, detection.eventType));

      const parsed = parseReservation(email.bodyText, detection.eventType);
      const text = formatLineMessage(parsed);

      if (targets.length === 0) {
        if (!deps.dryRun) {
          await recordNotification({
            salonId,
            eventType: detection.eventType,
            providerMessageId: messageId,
            lineText: text,
            status: "failed",
            errorMessage: "LINE未連携",
          });
        }
        result.dryRunDetails?.push({
          messageId,
          isHotPepper: true,
          eventType: detection.eventType,
          wouldNotify: false,
          previewText: text,
        });
        continue;
      }

      if (deps.dryRun) {
        result.dryRunDetails?.push({
          messageId,
          isHotPepper: true,
          eventType: detection.eventType,
          wouldNotify: true,
          recipientCount: targets.length,
          previewText: text,
        });
        continue;
      }

      // fan-out: 各送信先ごとに独立して送信・記録する。1人への送信失敗が
      // 他のスタッフへの送信・記録を妨げないよう、for文+個別try/catchにする
      // (Promise.allSettledでも良いが、LINEの送信レート・ログの読みやすさを
      // 優先してあえて逐次にしている)。
      for (const recipient of targets) {
        try {
          await deps.sendLine(recipient.destinationId!, text);
          await recordNotification({
            salonId,
            lineConnectionId: recipient.id,
            eventType: detection.eventType,
            providerMessageId: messageId,
            lineText: text,
            status: "sent",
          });
          result.notified++;
        } catch {
          await recordNotification({
            salonId,
            lineConnectionId: recipient.id,
            eventType: detection.eventType,
            providerMessageId: messageId,
            lineText: text,
            status: "failed",
            errorMessage: "LINEへの通知送信に失敗しました",
          });
        }
      }
    } catch (err) {
      // このメッセージ1件の想定外の失敗(例: Gmail取得の一時的エラー)が
      // 残りのバッチ処理を止めてはいけない。
      if (deps.dryRun) console.error(`[notifications dry-run] message ${messageId} failed:`, err);
    }
  }

  if (!deps.dryRun) await recordMailCheckSuccess(salonId);
  return result;
}
