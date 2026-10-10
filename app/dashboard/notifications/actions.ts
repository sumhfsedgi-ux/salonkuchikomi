"use server";

import { revalidatePath } from "next/cache";
import { resolveAccessibleSalon } from "@/lib/notifications/access";
import { setMasterEnabled } from "@/lib/notifications/recipients/db";
import { LOCKED_SETTING_MESSAGE, TEST_NOTIFICATION_TEXT, TEST_SEND_RESULT_MESSAGES } from "@/lib/notifications/recipients/messages";
import { listLineConnections } from "@/lib/notifications/db/lineConnections";
import { recordNotification, hasRecentTestNotification } from "@/lib/notifications/db/notificationHistory";
import { pushText, LineSendBlockedError, LineSendError } from "@/lib/notifications/line/LineClient";
import { isRealLineSendAllowed, resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";
import { customerStartReservationNotifications, type CustomerStartResult } from "@/lib/notifications/db/operations";
import { plansIncluding } from "@/lib/access/plan";

// 認証済みユーザー -> getCurrentSalon() -> salon.id の順で必ず解決する(lib/notifications/access.ts)。
// salonIdはクライアントから一切受け取らない。通知先・招待の操作は ./recipientActions.ts。

const TEST_MESSAGE = TEST_NOTIFICATION_TEXT;

/** 予約通知の全体スイッチ。切り替え待ちの間は DB の関数が受け付けない(画面も同じ判定で無効にする)。 */
export async function updateMasterEnabledAction(
  masterEnabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;
  const { salon } = resolved;

  try {
    const outcome = await setMasterEnabled(salon.id, masterEnabled);
    if (outcome === "locked") return { ok: false, error: LOCKED_SETTING_MESSAGE };
  } catch (err) {
    console.error("updateMasterEnabledAction failed", err instanceof Error ? err.message : "unknown");
    return { ok: false, error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard/notifications");
  return { ok: true };
}

/**
 * 接続中の全スタッフへテスト通知をfan-out送信する。1人への失敗が他を止めない。
 * 本番以外(開発・テスト用DB・擬似・プレビュー)では、実際には送らない(LINE の HTTP も履歴の記録もしない)。
 * 実送信の検証モードでは、指定した検証用の宛先にだけ送る(lib/notifications/line/sendPolicy.ts)。
 */
export async function sendTestNotificationAction(): Promise<{ ok: boolean; error?: string; message?: string }> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;
  const { salon } = resolved;

  const policy = resolveLineSendPolicy();
  const connected = (await listLineConnections(salon.id)).filter((r) => r.status === "connected" && r.destinationId);
  if (policy.mode === "simulated") {
    if (connected.length === 0) return { ok: false, error: "LINEが接続されていません。" };
    return { ok: true, message: TEST_SEND_RESULT_MESSAGES.simulated };
  }

  // 直前に送ったばかりなら二重送信せず、成功扱いで返す(連打対策)。
  if (await hasRecentTestNotification(salon.id)) return { ok: true, message: TEST_SEND_RESULT_MESSAGES[policy.mode] };

  const recipients = connected.filter((r) => isRealLineSendAllowed(policy, r.destinationId!));
  if (connected.length > 0 && recipients.length === 0) return { ok: true, message: TEST_SEND_RESULT_MESSAGES.simulated };
  if (recipients.length === 0) {
    await recordNotification({
      salonId: salon.id,
      eventType: "test",
      status: "failed",
      errorMessage: "LINE未連携",
    });
    revalidatePath("/dashboard/notifications");
    return { ok: false, error: "LINEが接続されていません。" };
  }

  // 各送信先ごとに独立してtry/catchする -- 1人への送信失敗が他のスタッフへの
  // 送信・記録を妨げない(pollMailForSalon.tsのfan-outと同じ方針)。テスト通知は
  // LINE疎通確認に限定するスコープのため、notification_deliveriesの配信追跡・
  // retry-keyによる再試行対象にはしない(都度生成のretryKeyで一度だけ試みる)。
  // pushTextはHTTP 200だけでなく、同じretryKeyで既に成功していたことが確認できる
  // 409も"sent"として扱う。
  let successCount = 0;
  let lastErrorMessage: string | undefined;
  for (const recipient of recipients) {
    try {
      const { outcome } = await pushText(recipient.destinationId!, TEST_MESSAGE, crypto.randomUUID());
      if (outcome === "sent") {
        await recordNotification({
          salonId: salon.id,
          lineConnectionId: recipient.id,
          eventType: "test",
          lineText: TEST_MESSAGE,
          status: "test",
        });
        successCount++;
      } else {
        lastErrorMessage = "LINEへの通知送信に失敗しました";
        await recordNotification({
          salonId: salon.id,
          lineConnectionId: recipient.id,
          eventType: "test",
          lineText: TEST_MESSAGE,
          status: outcome === "failed" ? "failed" : "unknown",
          errorMessage: lastErrorMessage,
        });
      }
    } catch (err) {
      // 送信の入口でも止められた(この環境では実際に送らない)。送っていないので記録しない。
      if (err instanceof LineSendBlockedError) continue;
      lastErrorMessage = err instanceof LineSendError ? err.message : "LINEへの通知送信に失敗しました";
      await recordNotification({
        salonId: salon.id,
        lineConnectionId: recipient.id,
        eventType: "test",
        lineText: TEST_MESSAGE,
        status: "failed",
        errorMessage: lastErrorMessage,
      });
    }
  }

  revalidatePath("/dashboard/notifications");
  return successCount > 0
    ? { ok: true, message: TEST_SEND_RESULT_MESSAGES[policy.mode] }
    : { ok: false, error: lastErrorMessage ?? "LINEへの通知送信に失敗しました" };
}

const START_ERRORS: Record<Exclude<CustomerStartResult, "started" | "already_active">, string> = {
  legacy_salon: "この店舗の予約通知は運営側で開始します。お客様の操作は不要です。",
  paused_by_operator: "予約通知は運営側で停止中です。お問い合わせください。",
  plan_not_allowed: "この機能はご契約に含まれていません。",
  not_selected: "利用する機能で「予約通知」を選んでください。",
  gmail_not_connected: "先にGoogleと連携してください。",
  no_line_recipients: "LINEの送信先が登録されていません。",
};

/**
 * 旧サービスを使っていない店舗だけが、画面から予約通知を開始できる。Google に接続しただけでは
 * 始まらない。開始の可否は DB の関数(reservation_ops_customer_start)とトリガーが確かめる
 * (画面の操作だけで旧側停止の確認を飛ばせない)。
 */
export async function startReservationNotificationsAction(): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;

  let result: CustomerStartResult;
  try {
    result = await customerStartReservationNotifications({
      salonId: resolved.salon.id,
      userId: resolved.userId,
      allowedPlans: plansIncluding("notifications"),
    });
  } catch {
    return { ok: false, error: "開始できませんでした。もう一度お試しください。" };
  }
  revalidatePath("/dashboard/notifications");
  revalidatePath("/dashboard");
  if (result === "started" || result === "already_active") return { ok: true };
  return { ok: false, error: START_ERRORS[result] };
}
