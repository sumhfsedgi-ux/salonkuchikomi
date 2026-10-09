import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// reservation_notification_operations(0022): 予約通知の運用状態。Google の認証状態とは別に管理する。
// 開始(active)への遷移は DB のトリガーが最終確認する(旧サービス利用店舗は旧側停止の確認と
// 履歴照合の受け入れが無ければ拒否)。

export type ReservationOpsState = "setup_pending" | "awaiting_cutover" | "active" | "paused";

export interface ReservationOperations {
  salonId: string;
  state: ReservationOpsState;
  legacySource: "hmail" | null;
  legacyStopConfirmedAt: string | null;
  acceptedReconciliationId: string | null;
  mailFetchSince: string | null;
  mailFetchSinceReason: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
}

export async function getReservationOperations(salonId: string): Promise<ReservationOperations | null> {
  const { data, error } = await getNotificationsSupabaseAdmin()
    .from("reservation_notification_operations")
    .select(
      "salon_id, state, legacy_source, legacy_stop_confirmed_at, accepted_reconciliation_id, mail_fetch_since, mail_fetch_since_reason, activated_at, paused_at, pause_reason"
    )
    .eq("salon_id", salonId)
    .maybeSingle();
  if (error) throw new Error("予約通知の運用状態の取得に失敗しました。");
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    salonId: r.salon_id as string,
    state: r.state as ReservationOpsState,
    legacySource: (r.legacy_source as "hmail" | null) ?? null,
    legacyStopConfirmedAt: (r.legacy_stop_confirmed_at as string | null) ?? null,
    acceptedReconciliationId: (r.accepted_reconciliation_id as string | null) ?? null,
    mailFetchSince: (r.mail_fetch_since as string | null) ?? null,
    mailFetchSinceReason: (r.mail_fetch_since_reason as string | null) ?? null,
    activatedAt: (r.activated_at as string | null) ?? null,
    pausedAt: (r.paused_at as string | null) ?? null,
    pauseReason: (r.pause_reason as string | null) ?? null,
  };
}

export type AutoStopKind = "auth" | "gmail_scope" | "outage";

export interface PollableSalon {
  salonId: string;
  googleAccountId: string;
  mailFetchSince: Date;
  /** mail_fetch_since を決めたときに予約メールに使っていたアカウント(lib/notifications/mail/fetchStart.ts)。 */
  mailFetchAccountId: string | null;
  accountBoundAt: Date;
  legacySource: string | null;
  /** 予約メール(Gmail)の権限だけが足りないと記録した日時(アカウント全体の認証状態とは別)。 */
  gmailScopeMissingSince: Date | null;
  /** 開いたままの、障害・認証・権限不足による停止期間。 */
  openAutoStops: AutoStopKind[];
}

export async function listPollableSalons(allowedPlans: string[]): Promise<PollableSalon[]> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("notifications_list_pollable_salons", {
    p_allowed_plans: allowedPlans,
  });
  if (error) throw new Error("予約通知の対象店舗の取得に失敗しました。");
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    salonId: r.salon_id as string,
    googleAccountId: r.google_account_id as string,
    mailFetchSince: new Date(r.mail_fetch_since as string),
    mailFetchAccountId: (r.mail_fetch_account_id as string | null) ?? null,
    accountBoundAt: new Date(r.account_bound_at as string),
    legacySource: (r.legacy_source as string | null) ?? null,
    gmailScopeMissingSince: r.gmail_scope_missing_since ? new Date(r.gmail_scope_missing_since as string) : null,
    openAutoStops: ((r.open_auto_stops as string[] | null) ?? []) as AutoStopKind[],
  }));
}

export type LegacyState = "not_legacy" | "stopped" | "active" | "unknown";

export async function getLegacyState(salonId: string): Promise<LegacyState> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("reservation_ops_legacy_state", { p_salon_id: salonId });
  if (error) return "unknown";
  return data as LegacyState;
}

/** 運営・システムによる停止。送信開始済みで結果がまだ出ていない配信の件数を返す。 */
export async function pauseReservationNotifications(params: {
  salonId: string;
  by: string;
  reason: string;
  kind: "operator_pause" | "legacy_active";
}): Promise<number> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("reservation_ops_pause", {
    p_salon_id: params.salonId,
    p_by: params.by,
    p_reason: params.reason,
    p_kind: params.kind,
  });
  if (error) throw new Error("予約通知の停止に失敗しました。");
  return data as number;
}

export type CustomerStartResult =
  | "started"
  | "legacy_salon"
  | "already_active"
  | "paused_by_operator"
  | "plan_not_allowed"
  | "not_selected"
  | "gmail_not_connected"
  | "no_line_recipients";

/** お客様による開始(旧サービスを使っていない店舗だけ。DB 側で再確認する)。 */
export async function customerStartReservationNotifications(params: {
  salonId: string;
  userId: string;
  allowedPlans: string[];
}): Promise<CustomerStartResult> {
  const { data, error } = await getNotificationsSupabaseAdmin().rpc("reservation_ops_customer_start", {
    p_salon_id: params.salonId,
    p_user_id: params.userId,
    p_allowed_plans: params.allowedPlans,
  });
  if (error) throw new Error("予約通知の開始に失敗しました。");
  return data as CustomerStartResult;
}

export async function openStopInterval(salonId: string, kind: AutoStopKind, by: string, note: string | null): Promise<void> {
  const { error } = await getNotificationsSupabaseAdmin().rpc("reservation_open_stop", {
    p_salon_id: salonId,
    p_kind: kind,
    p_by: by,
    p_note: note,
  });
  if (error) console.error("[notifications] openStopInterval failed", { code: error.code });
}

export async function closeStopInterval(salonId: string, kind: AutoStopKind, by: string): Promise<void> {
  const { error } = await getNotificationsSupabaseAdmin().rpc("reservation_close_stop", { p_salon_id: salonId, p_kind: kind, p_by: by });
  if (error) console.error("[notifications] closeStopInterval failed", { code: error.code });
}
