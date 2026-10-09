import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// notification_deliveries(0020 で作成、0022 で拡張)。「メール×LINE送信先」ごとの配信の記録。
// 取り出し・送信直前の確認・結果の記録は、すべて処理権(claim_token)付きの DB 関数で行う
// (古い処理が、停止状態や新しい送信結果を上書きできない)。

export type DeliveryStatus = "pending" | "claimed" | "sent" | "failed" | "unknown" | "skipped" | "needs_review" | "retry_wait";

export interface ClaimedDelivery {
  id: string;
  salonId: string;
  providerMessageId: string;
  lineConnectionId: string;
  eventType: string;
  claimToken: string;
  attempts: number;
  firstAttemptAt: string | null;
}

interface ClaimRow {
  id: string;
  salon_id: string;
  provider_message_id: string;
  line_connection_id: string;
  event_type: string;
  claim_token: string;
  attempts: number;
  first_attempt_at: string | null;
}

export async function classifyEmail(params: {
  processedId: string;
  eventType: string;
  lineText: string | null;
  mailReceivedAt: Date | null;
  recipients: Array<{ lineConnectionId: string; destinationId: string }>;
}): Promise<number> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_classify_email", {
    p_processed_id: params.processedId,
    p_event_type: params.eventType,
    p_line_text: params.lineText,
    p_mail_received_at: params.mailReceivedAt?.toISOString() ?? null,
    p_recipients: params.recipients.map((r) => ({ line_connection_id: r.lineConnectionId, destination_id: r.destinationId })),
  });
  if (error) throw new Error("メールの分類の記録に失敗しました。");
  return data as number;
}

export async function claimDelivery(salonId: string, allowedPlans: string[]): Promise<ClaimedDelivery | null> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_claim_delivery_v2", {
    p_salon_id: salonId,
    p_allowed_plans: allowedPlans,
  });
  if (error) throw new Error("配信の取り出しに失敗しました。");
  const row = (data as ClaimRow[] | null)?.[0];
  return row
    ? {
        id: row.id,
        salonId: row.salon_id,
        providerMessageId: row.provider_message_id,
        lineConnectionId: row.line_connection_id,
        eventType: row.event_type,
        claimToken: row.claim_token,
        attempts: row.attempts,
        firstAttemptAt: row.first_attempt_at,
      }
    : null;
}

export type BeginSendDecision =
  | { decision: "send"; destinationId: string; lineText: string; lineRetryKey: string; eventType: string; lineConnectionId: string }
  | { decision: "skipped"; reason: string; eventType: string; lineConnectionId: string }
  | { decision: "needs_review" | "released" | "expired" | "lost"; reason: string };

interface BeginRow {
  decision: string;
  reason: string | null;
  destination_id: string | null;
  line_text: string | null;
  line_retry_key: string | null;
  event_type: string | null;
  line_connection_id: string | null;
}

export async function beginSend(delivery: ClaimedDelivery, allowedPlans: string[]): Promise<BeginSendDecision> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_begin_send", {
    p_id: delivery.id,
    p_claim_token: delivery.claimToken,
    p_allowed_plans: allowedPlans,
  });
  if (error) throw new Error("送信前の確認に失敗しました。");
  const row = (data as BeginRow[] | null)?.[0];
  if (!row) return { decision: "lost", reason: "no_row" };
  if (row.decision === "send") {
    return {
      decision: "send",
      destinationId: row.destination_id!,
      lineText: row.line_text!,
      lineRetryKey: row.line_retry_key!,
      eventType: row.event_type!,
      lineConnectionId: row.line_connection_id!,
    };
  }
  if (row.decision === "skipped") {
    return { decision: "skipped", reason: row.reason ?? "", eventType: row.event_type!, lineConnectionId: row.line_connection_id! };
  }
  return { decision: row.decision as "needs_review" | "released" | "expired" | "lost", reason: row.reason ?? "" };
}

/** 送信結果を記録する。false は処理権を失っていた(外部への送信が取り消されたという意味ではない)。 */
export async function finishDelivery(params: {
  delivery: ClaimedDelivery;
  outcome: "sent" | "failed" | "unknown" | "retry_wait";
  lineRequestId?: string | null;
  error?: string | null;
  retryAfterSeconds?: number;
}): Promise<boolean> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_finish_delivery", {
    p_id: params.delivery.id,
    p_claim_token: params.delivery.claimToken,
    p_outcome: params.outcome,
    p_line_request_id: params.lineRequestId ?? null,
    p_error: params.error ?? null,
    p_retry_after: params.retryAfterSeconds ? `${params.retryAfterSeconds} seconds` : null,
  });
  if (error) throw new Error("送信結果の記録に失敗しました。");
  return data === true;
}

/**
 * 締切のため、取り出した配信を送らずに戻す(送信直前の確認の前。未送信と断定できる)。
 * false は処理権を失っていたか、既に送信を始めていた(戻さない)。
 */
export async function releaseClaim(delivery: ClaimedDelivery): Promise<boolean> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_release_claim", {
    p_id: delivery.id,
    p_claim_token: delivery.claimToken,
  });
  if (error) throw new Error("配信の取り出しの取り消しに失敗しました。");
  return data === true;
}

/**
 * 締切のため、送信直前の確認('send')のあとに LINE を呼ばずにやめた配信を戻す(未送信と断定できる)。
 * LINE を呼んだあとには使わない。
 */
export async function cancelSendStart(delivery: ClaimedDelivery): Promise<boolean> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_cancel_send_start", {
    p_id: delivery.id,
    p_claim_token: delivery.claimToken,
  });
  if (error) throw new Error("送信開始の取り消しに失敗しました。");
  return data === true;
}

/** 定期処理が使う配信の DB 操作(テストで遅延・失敗を差し込めるように、まとめて差し替えられる)。 */
export interface DeliveryStore {
  claim: typeof claimDelivery;
  begin: typeof beginSend;
  finish: typeof finishDelivery;
  releaseClaim: typeof releaseClaim;
  cancelSendStart: typeof cancelSendStart;
}

export const dbDeliveryStore: DeliveryStore = {
  claim: claimDelivery,
  begin: beginSend,
  finish: finishDelivery,
  releaseClaim,
  cancelSendStart,
};

export interface DeliveryView {
  id: string;
  providerMessageId: string;
  lineConnectionId: string;
  eventType: string;
  status: DeliveryStatus;
  skipReason: string | null;
  origin: "salonpack" | "hmail";
  mailReceivedAt: string | null;
  firstAttemptAt: string | null;
  updatedAt: string;
  lineText: string;
}

/** 画面の「最近の通知」用(配信の記録から作る)。 */
export async function listRecentDeliveries(salonId: string, limit = 20): Promise<DeliveryView[]> {
  const { data, error } = await getNotificationsSupabaseAdmin()
    .from("notification_deliveries")
    .select("id, provider_message_id, line_connection_id, event_type, status, skip_reason, origin, mail_received_at, first_attempt_at, updated_at, line_text")
    .eq("salon_id", salonId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("通知履歴の取得に失敗しました。");
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    providerMessageId: r.provider_message_id as string,
    lineConnectionId: r.line_connection_id as string,
    eventType: r.event_type as string,
    status: r.status as DeliveryStatus,
    skipReason: (r.skip_reason as string | null) ?? null,
    origin: r.origin as "salonpack" | "hmail",
    mailReceivedAt: (r.mail_received_at as string | null) ?? null,
    firstAttemptAt: (r.first_attempt_at as string | null) ?? null,
    updatedAt: r.updated_at as string,
    lineText: r.line_text as string,
  }));
}
