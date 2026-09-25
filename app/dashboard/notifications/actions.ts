"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { updateNotificationSettings as updateMasterEnabledInDb } from "@/lib/notifications/db/notificationSettings";
import {
  listLineConnections,
  updateLineConnectionSettings as updateLineConnectionSettingsInDb,
  type LineConnectionSettingsUpdate,
} from "@/lib/notifications/db/lineConnections";
import { recordNotification, hasRecentTestNotification } from "@/lib/notifications/db/notificationHistory";
import { pushText, LineSendError } from "@/lib/notifications/line/LineClient";

// 認証済みユーザー -> getCurrentSalon() -> salon.id の順で必ず解決する。
// salonIdはクライアントから一切受け取らない(hmail統合PLANの認証統合方針、
// lib/blog/settings/actionsと同じパターン)。line_connection_idはクライアント
// から受け取るが、更新時に必ずsalon.idと一致するか照合する(他店舗の
// 送信先を書き換えられないようにするため -- lib/notifications/db/lineConnections.ts参照)。

const TEST_MESSAGE = "予約通知の設定が完了しました";

export async function updateMasterEnabledAction(
  masterEnabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "ログインが必要です。" };

  try {
    await updateMasterEnabledInDb(salon.id, masterEnabled);
  } catch (err) {
    console.error("updateMasterEnabledAction failed", err);
    return { ok: false, error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard/notifications");
  return { ok: true };
}

export async function updateLineConnectionSettingsAction(
  connectionId: string,
  patch: LineConnectionSettingsUpdate
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "ログインが必要です。" };

  try {
    await updateLineConnectionSettingsInDb(connectionId, salon.id, patch);
  } catch (err) {
    console.error("updateLineConnectionSettingsAction failed", err);
    return { ok: false, error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard/notifications");
  return { ok: true };
}

/** 接続中の全スタッフへテスト通知をfan-out送信する。1人への失敗が他を止めない。 */
export async function sendTestNotificationAction(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "ログインが必要です。" };

  // 直前に送ったばかりなら二重送信せず、成功扱いで返す(連打対策)。
  if (await hasRecentTestNotification(salon.id)) return { ok: true };

  const recipients = (await listLineConnections(salon.id)).filter(
    (r) => r.status === "connected" && r.destinationId
  );
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
  // 送信・記録を妨げない(pollMailForSalon.tsのfan-outと同じ方針)。
  let successCount = 0;
  let lastErrorMessage: string | undefined;
  for (const recipient of recipients) {
    try {
      await pushText(recipient.destinationId!, TEST_MESSAGE);
      await recordNotification({
        salonId: salon.id,
        lineConnectionId: recipient.id,
        eventType: "test",
        lineText: TEST_MESSAGE,
        status: "test",
      });
      successCount++;
    } catch (err) {
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
  return successCount > 0 ? { ok: true } : { ok: false, error: lastErrorMessage };
}
