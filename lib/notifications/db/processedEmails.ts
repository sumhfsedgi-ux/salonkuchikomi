import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import type { EventType } from "@/lib/notifications/hotpepper/types";

// (hmailの lib/db/processedEmails.ts を移植。Drizzleの
// `insert().onConflictDoNothing().returning()` は、Supabase JSクライアントでは
// `upsert(..., { ignoreDuplicates: true }).select()` に相当する
// -- 既にlib/blog/queries.tsのbulkInsertReferencePosts/ensureSalonSettingsRowで
// 使われている既存パターンと同じ。)

/**
 * あるサロンの、あるGmailメッセージを処理する権利を原子的にクレームする。
 * このメールを初めて見た呼び出しなら新規行のidを返し、既に誰か
 * (同時実行中のcronを含む)がクレーム済みなら null を返す
 * -- 呼び出し元はnullなら完全にスキップすること。
 *
 * 「本文取得より先にクレームする」というこの順序と、
 * unique(salon_id, provider_message_id)制約により、cronが自分自身と
 * 同時に走っても同じメールへの二重LINE通知が構造的に起こり得なくなる。
 */
export async function claimMessageForProcessing(
  salonId: string,
  providerMessageId: string
): Promise<string | null> {
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("processed_emails")
    .upsert(
      { salon_id: salonId, provider_message_id: providerMessageId, event_type: "pending" },
      { onConflict: "salon_id,provider_message_id", ignoreDuplicates: true }
    )
    .select("id");

  if (error) {
    console.error("claimMessageForProcessing failed:", error);
    throw new Error("メールのクレームに失敗しました。");
  }
  return data?.[0]?.id ?? null;
}

export async function recordEventType(
  claimedRowId: string,
  eventType: EventType | "not_hotpepper"
): Promise<void> {
  const supabase = getNotificationsSupabaseAdmin();
  const { error } = await supabase
    .from("processed_emails")
    .update({ event_type: eventType })
    .eq("id", claimedRowId);

  if (error) console.error("recordEventType failed:", error);
}
