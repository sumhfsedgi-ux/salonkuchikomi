import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { SalonPlan } from "@/lib/access/plan";
import { isFeatureKey, type FeatureKey } from "@/lib/features/registry";
import { toSalonEntitlements, type EntitlementRow, type FeatureLifecycle, type SalonEntitlements } from "@/lib/features/entitlements";
import type { CatalogEntry, PlanRules } from "@/lib/ops/preview";
import { isRegistrationSource, isServiceStatus, type RegistrationSource, type ServiceStatus } from "@/lib/onboarding/serviceStatus";

// 運営管理の画面が読むデータ。service role で読む(呼び出し側は必ず requireOperator() のあとで呼ぶ)。
// 秘密の値(リフレッシュトークン・暗号文・LINE の宛先 ID・パスワード)は select しない。

export interface SalonListRow {
  id: string;
  name: string;
  slug: string;
  /** 区分で意味が変わる(利用中: 契約プラン / 利用開始待ち: 予定のプラン)。表示は planDisplay(lib/ops/onboardingDisplay)を使う。 */
  plan: SalonPlan;
  /** true のとき plan は仮の値(プラン未定)。 */
  planPlaceholder: boolean;
  createdAt: string;
  ownerEmail: string | null;
  entitled: Partial<Record<FeatureKey, boolean>>;
  openHolds: FeatureKey[];
  serviceStatus: ServiceStatus;
  registrationSource: RegistrationSource;
  /** 運営が登録した店舗の招待の状態(none = 運営の登録ではない)。complete = メール確認済み・本人確認の記録あり。 */
  invitationState: "none" | "incomplete" | "complete";
  invitationLastResult: "sending" | "accepted" | "failed" | "simulated" | null;
}

export interface SalonListCursor {
  createdAt: string;
  id: string;
}

export const SALON_PAGE_SIZE = 50;

export async function listSalons(params: {
  query: string | null;
  plan: SalonPlan | null;
  featureKey: FeatureKey | null;
  featureAllowed: boolean | null;
  after: SalonListCursor | null;
  serviceStatus?: ServiceStatus | null;
}): Promise<{ rows: SalonListRow[]; next: SalonListCursor | null }> {
  const { data, error } = await getSupabaseAdmin().rpc("admin_list_salons", {
    p_query: params.query,
    p_plan: params.plan,
    p_feature_key: params.featureKey,
    p_feature_allowed: params.featureAllowed,
    p_after_created_at: params.after?.createdAt ?? null,
    p_after_id: params.after?.id ?? null,
    // 次のページがあるかを知るため、1件多く読む。
    p_limit: SALON_PAGE_SIZE + 1,
    p_service_status: params.serviceStatus ?? null,
  });
  if (error) throw new Error("サロンの一覧の取得に失敗しました。");
  const all = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    plan: r.plan as SalonPlan,
    planPlaceholder: r.plan_placeholder === true,
    createdAt: r.created_at as string,
    ownerEmail: (r.owner_email as string | null) ?? null,
    entitled: (r.entitled ?? {}) as SalonListRow["entitled"],
    openHolds: ((r.open_holds as string[] | null) ?? []).filter(isFeatureKey),
    serviceStatus: isServiceStatus(r.service_status) ? r.service_status : "pending",
    registrationSource: isRegistrationSource(r.registration_source) ? r.registration_source : "self_signup",
    invitationState: (r.invitation_state === "complete" || r.invitation_state === "incomplete" ? r.invitation_state : "none") as SalonListRow["invitationState"],
    invitationLastResult: (r.invitation_last_result as SalonListRow["invitationLastResult"]) ?? null,
  }));
  const rows = all.slice(0, SALON_PAGE_SIZE);
  const last = rows[rows.length - 1];
  return { rows, next: all.length > SALON_PAGE_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null };
}

export interface FeatureHold {
  id: string;
  featureKey: FeatureKey;
  openedAt: string;
  openedBy: string;
  reason: string | null;
}

export interface GoogleBindingSummary {
  feature: "gmail" | "gbp";
  accountEmail: string | null;
  authState: string;
  scopeMissingSince: string | null;
  firstConnectedAt: string;
  lastReconnectedAt: string | null;
  gbpSelectionState: string | null;
}

export interface ReservationOpsSummary {
  state: "setup_pending" | "awaiting_cutover" | "active" | "paused" | null;
  /** 旧サービスから移る店舗か(開始・切り替えは運営が行う)。 */
  legacy: boolean;
  pauseReason: string | null;
  activatedAt: string | null;
  masterEnabled: boolean;
  /** お客様の「利用を停止する」(内部スイッチ)。行が無ければ null。 */
  customerSwitchOn: boolean | null;
  lastMailCheckAt: string | null;
  lineRecipients: number;
}

export interface SalonDetail {
  id: string;
  name: string;
  slug: string;
  /** 区分で意味が変わる(利用中: 契約プラン / 利用開始待ち: 予定のプラン)。表示は planDisplay を使う。 */
  plan: SalonPlan;
  /** true のとき plan は仮の値(プラン未定)。 */
  planPlaceholder: boolean;
  businessType: string | null;
  description: string | null;
  googleReviewUrl: string | null;
  onboardingCompleted: boolean;
  createdAt: string;
  updatedAt: string;
  ownerEmail: string | null;
  version: number;
  entitlements: SalonEntitlements;
  catalog: Partial<Record<FeatureKey, CatalogEntry>>;
  rules: PlanRules;
  holds: FeatureHold[];
  google: GoogleBindingSummary[];
  reservation: ReservationOpsSummary;
}

export async function getSalonDetail(salonId: string): Promise<SalonDetail | null> {
  const db = getSupabaseAdmin();
  const [salon, placeholder, access, catalog, rules, holds, bindings, ops, master, sw, scan, lines] = await Promise.all([
    db.rpc("admin_get_salon", { p_salon_id: salonId }),
    db.from("salons").select("plan_placeholder").eq("id", salonId).maybeSingle(),
    db.rpc("salon_feature_access_all", { p_salon_id: salonId }),
    db.from("feature_catalog").select("feature_key, lifecycle, has_runtime"),
    db.from("plan_feature_rules").select("plan, feature_key, default_enabled"),
    db.from("salon_feature_holds").select("id, feature_key, opened_at, opened_by, reason").eq("salon_id", salonId).is("released_at", null),
    db
      .from("salon_google_bindings")
      .select("feature, account_email, scope_missing_since, first_connected_at, last_reconnected_at, gbp_selection_state, google_accounts(auth_state, email)")
      .eq("salon_id", salonId),
    db
      .from("reservation_notification_operations")
      .select("state, pause_reason, activated_at, legacy_source")
      .eq("salon_id", salonId)
      .maybeSingle(),
    db.from("notification_settings").select("master_enabled").eq("salon_id", salonId).maybeSingle(),
    db.from("salon_feature_selections").select("selected").eq("salon_id", salonId).eq("feature_key", "reservation_notifications").maybeSingle(),
    db.from("gmail_scan_state").select("last_tick_at").eq("salon_id", salonId).maybeSingle(),
    db.from("line_connections").select("status, destination_id, removed_at").eq("salon_id", salonId),
  ]);
  for (const r of [salon, placeholder, access, catalog, rules, holds, bindings, ops, master, sw, scan, lines]) {
    if (r.error) throw new Error("サロンの詳細の取得に失敗しました。");
  }
  const base = ((salon.data ?? []) as Array<Record<string, unknown>>)[0];
  if (!base) return null;

  const catalogMap: Partial<Record<FeatureKey, CatalogEntry>> = {};
  for (const c of (catalog.data ?? []) as Array<{ feature_key: string; lifecycle: FeatureLifecycle; has_runtime: boolean }>) {
    if (isFeatureKey(c.feature_key)) catalogMap[c.feature_key] = { lifecycle: c.lifecycle, hasRuntime: c.has_runtime };
  }
  const planRules: PlanRules = { reviews: {}, salonpack: {} };
  for (const r of (rules.data ?? []) as Array<{ plan: SalonPlan; feature_key: string; default_enabled: boolean }>) {
    planRules[r.plan] = { ...planRules[r.plan], [r.feature_key]: r.default_enabled };
  }
  const opsRow = ops.data as Record<string, string | null> | null;
  const lineRows = (lines.data ?? []) as Array<{ status: string; destination_id: string | null; removed_at: string | null }>;

  return {
    id: base.id as string,
    name: base.name as string,
    slug: base.slug as string,
    plan: base.plan as SalonPlan,
    planPlaceholder: (placeholder.data as { plan_placeholder?: boolean } | null)?.plan_placeholder === true,
    businessType: (base.business_type as string | null) ?? null,
    description: (base.description as string | null) ?? null,
    googleReviewUrl: (base.google_review_url as string | null) ?? null,
    onboardingCompleted: Boolean(base.onboarding_completed),
    createdAt: base.created_at as string,
    updatedAt: base.updated_at as string,
    ownerEmail: (base.owner_email as string | null) ?? null,
    version: Number(base.version ?? 0),
    entitlements: toSalonEntitlements((access.data ?? []) as EntitlementRow[], isFeatureKey),
    catalog: catalogMap,
    rules: planRules,
    holds: ((holds.data ?? []) as Array<Record<string, string | null>>)
      .filter((h) => isFeatureKey(h.feature_key))
      .map((h) => ({
        id: h.id as string,
        featureKey: h.feature_key as FeatureKey,
        openedAt: h.opened_at as string,
        openedBy: h.opened_by as string,
        reason: h.reason ?? null,
      })),
    google: ((bindings.data ?? []) as Array<Record<string, unknown>>).map((b) => {
      const account = (Array.isArray(b.google_accounts) ? b.google_accounts[0] : b.google_accounts) as { auth_state?: string; email?: string | null } | null;
      return {
        feature: b.feature as "gmail" | "gbp",
        accountEmail: (b.account_email as string | null) ?? account?.email ?? null,
        authState: account?.auth_state ?? "unknown",
        scopeMissingSince: (b.scope_missing_since as string | null) ?? null,
        firstConnectedAt: b.first_connected_at as string,
        lastReconnectedAt: (b.last_reconnected_at as string | null) ?? null,
        gbpSelectionState: (b.gbp_selection_state as string | null) ?? null,
      };
    }),
    reservation: {
      state: (opsRow?.state as ReservationOpsSummary["state"]) ?? null,
      legacy: Boolean(opsRow?.legacy_source),
      pauseReason: opsRow?.pause_reason ?? null,
      activatedAt: opsRow?.activated_at ?? null,
      masterEnabled: (master.data as { master_enabled: boolean } | null)?.master_enabled ?? true,
      customerSwitchOn: (sw.data as { selected: boolean } | null)?.selected ?? null,
      lastMailCheckAt: (scan.data as { last_tick_at: string | null } | null)?.last_tick_at ?? null,
      lineRecipients: lineRows.filter((r) => r.status === "connected" && r.destination_id && !r.removed_at).length,
    },
  };
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorKind: "operator" | "cli" | "sql" | "system" | "owner";
  actorEmail: string | null;
  actorLabel: string | null;
  target: string;
  before: unknown;
  after: unknown;
  note: string | null;
}

export const AUDIT_PAGE_SIZE = 30;

export async function listAuditLog(salonId: string, beforeId: string | null): Promise<{ rows: AuditEntry[]; nextBefore: string | null }> {
  const { data, error } = await getSupabaseAdmin().rpc("admin_audit_log", {
    p_salon_id: salonId,
    p_before_id: beforeId,
    p_limit: AUDIT_PAGE_SIZE + 1,
  });
  if (error) throw new Error("変更履歴の取得に失敗しました。");
  const all = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    occurredAt: r.occurred_at as string,
    actorKind: r.actor_kind as AuditEntry["actorKind"],
    actorEmail: (r.actor_email as string | null) ?? null,
    actorLabel: (r.actor_label as string | null) ?? null,
    target: r.target as string,
    before: r.before,
    after: r.after,
    note: (r.note as string | null) ?? null,
  }));
  const rows = all.slice(0, AUDIT_PAGE_SIZE);
  return { rows, nextBefore: all.length > AUDIT_PAGE_SIZE ? rows[rows.length - 1].id : null };
}
