import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// (hmailの lib/db/processedEmails.ts を移植・再設計)
// claim-before-read: 本文を取得する前に、unique(salon_id, provider_message_id) へ挿入してクレームする。
// 分類(イベント種別の記録)と配信行の作成は notifications_classify_email(0022)で1つのトランザクションにする。

/**
 * 一覧で見つかったメールのうち、まだ誰もクレームしていないものだけを返す(1回の問い合わせ)。
 * 読み飛ばしの判定には使わない(本当の排他はクレームの unique で行う)。処理済みのメールが並ぶページで、
 * 1通ずつクレームを試みて時間を使わないためのもの。
 */
export async function filterUnclaimed(salonId: string, providerMessageIds: string[]): Promise<string[]> {
  if (providerMessageIds.length === 0) return [];
  const { data, error } = await getNotificationsSupabaseAdmin()
    .from("processed_emails")
    .select("provider_message_id")
    .eq("salon_id", salonId)
    .in("provider_message_id", providerMessageIds);
  if (error) throw new Error("処理済みメールの確認に失敗しました。");
  const claimed = new Set(((data ?? []) as Array<{ provider_message_id: string }>).map((r) => r.provider_message_id));
  return providerMessageIds.filter((id) => !claimed.has(id));
}

/** このメールを処理する権利を原子的にクレームする。既に誰かがクレーム済みなら null。 */
export async function claimMessageForProcessing(salonId: string, providerMessageId: string): Promise<string | null> {
  const { data, error } = await getNotificationsSupabaseAdmin()
    .from("processed_emails")
    .upsert(
      { salon_id: salonId, provider_message_id: providerMessageId, event_type: "pending", classify_attempts: 1 },
      { onConflict: "salon_id,provider_message_id", ignoreDuplicates: true }
    )
    .select("id");
  if (error) throw new Error("メールのクレームに失敗しました。");
  return data?.[0]?.id ?? null;
}

/**
 * 締切のためにクレームしたメールの処理を途中でやめたとき、失敗として数えずに、次の回にすぐ
 * 再クレームできる状態へ戻す(滞留メールの再クレームで拾う)。
 */
export async function releaseEmailClaim(processedId: string): Promise<void> {
  const { error } = await getNotificationsSupabaseAdmin().rpc("notifications_release_email_claim", { p_processed_id: processedId });
  if (error) throw new Error("メールのクレームの解除に失敗しました。");
}

export interface StuckEmailClaim {
  id: string;
  providerMessageId: string;
}

/**
 * 分類が一時的に失敗して pending のまま残ったメールを1件、再度クレームする
 * (上限回数を超えたものは unprocessable にして運営の確認へ回し、再試行の枠を占有させない)。
 */
export async function reclaimStuckEmail(salonId: string): Promise<StuckEmailClaim | null> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_reclaim_stuck_email_v2", { p_salon_id: salonId });
  if (error) throw new Error("滞留メールの再クレームに失敗しました。");
  const row = (data as Array<{ id: string; provider_message_id: string }> | null)?.[0];
  return row ? { id: row.id, providerMessageId: row.provider_message_id } : null;
}
