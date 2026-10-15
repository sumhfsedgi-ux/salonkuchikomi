import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { SalonPlan } from "@/lib/access/plan";
import { isFeatureKey, type FeatureKey } from "@/lib/features/registry";
import type { FeatureLifecycle, OverrideMode } from "@/lib/features/entitlements";
import type { CatalogEntry, PlanRules } from "@/lib/ops/preview";
import {
  isRegistrationKind,
  isRegistrationSource,
  isServiceStatus,
  type RegistrationKind,
  type RegistrationSource,
  type ServiceStatus,
} from "@/lib/onboarding/serviceStatus";
import type { InvitationKind } from "@/lib/onboarding/invitation";

// 運営の「サロンを追加」(下書き)・利用区分・招待と案内の画面が読むデータ。service role で読む
// (呼び出し側は必ず requireOperator() のあとで呼ぶ)。パスワード・トークンは読まない。

export interface CatalogAndRules {
  catalog: Partial<Record<FeatureKey, CatalogEntry>>;
  rules: PlanRules;
}

export async function loadCatalogAndRules(): Promise<CatalogAndRules> {
  const db = getSupabaseAdmin();
  const [catalog, rules] = await Promise.all([
    db.from("feature_catalog").select("feature_key, lifecycle, has_runtime"),
    db.from("plan_feature_rules").select("plan, feature_key, default_enabled"),
  ]);
  if (catalog.error || rules.error) throw new Error("機能の一覧の取得に失敗しました。");
  const catalogMap: Partial<Record<FeatureKey, CatalogEntry>> = {};
  for (const c of (catalog.data ?? []) as Array<{ feature_key: string; lifecycle: FeatureLifecycle; has_runtime: boolean }>) {
    if (isFeatureKey(c.feature_key)) catalogMap[c.feature_key] = { lifecycle: c.lifecycle, hasRuntime: c.has_runtime };
  }
  const planRules: PlanRules = { reviews: {}, salonpack: {} };
  for (const r of (rules.data ?? []) as Array<{ plan: SalonPlan; feature_key: string; default_enabled: boolean }>) {
    planRules[r.plan] = { ...planRules[r.plan], [r.feature_key]: r.default_enabled };
  }
  return { catalog: catalogMap, rules: planRules };
}

export interface SalonDraft {
  id: string;
  status: "draft" | "registered";
  name: string;
  contactName: string | null;
  loginEmail: string | null;
  businessType: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  plan: SalonPlan | null;
  /** 新しい店舗の登録種別(通常登録・テスト用)。0025 のときに保存された「無料提供」は、選び直してもらうため null にする。 */
  serviceStatus: RegistrationKind | null;
  /** 0025 のときに「無料提供」で保存された下書き(新しい店舗では選べなくなったことを画面で知らせる)。 */
  savedAsComplimentary: boolean;
  featureOverrides: Partial<Record<FeatureKey, Exclude<OverrideMode, "inherit">>>;
  salonId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function toDraft(r: Record<string, unknown>): SalonDraft {
  const overrides: SalonDraft["featureOverrides"] = {};
  for (const [k, v] of Object.entries((r.feature_overrides ?? {}) as Record<string, unknown>)) {
    if (isFeatureKey(k) && (v === "allow" || v === "deny")) overrides[k] = v;
  }
  return {
    id: r.id as string,
    status: r.status === "registered" ? "registered" : "draft",
    name: r.name as string,
    contactName: (r.contact_name as string | null) ?? null,
    loginEmail: (r.login_email as string | null) ?? null,
    businessType: (r.business_type as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    contactPhone: (r.contact_phone as string | null) ?? null,
    plan: r.plan === "reviews" || r.plan === "salonpack" ? r.plan : null,
    serviceStatus: isRegistrationKind(r.service_status) ? r.service_status : null,
    savedAsComplimentary: r.service_status === "complimentary",
    featureOverrides: overrides,
    salonId: (r.salon_id as string | null) ?? null,
    version: Number(r.version ?? 0),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const DRAFT_COLUMNS =
  "id, status, name, contact_name, login_email, business_type, contact_email, contact_phone, plan, service_status, feature_overrides, salon_id, version, created_at, updated_at";

/** 下書き(本登録の前)。新しい順。 */
export async function listDrafts(limit = 100): Promise<SalonDraft[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("salon_drafts")
    .select(DRAFT_COLUMNS)
    .eq("status", "draft")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("下書きの取得に失敗しました。");
  return ((data ?? []) as Array<Record<string, unknown>>).map(toDraft);
}

export async function getDraft(id: string): Promise<SalonDraft | null> {
  const { data, error } = await getSupabaseAdmin().from("salon_drafts").select(DRAFT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error("下書きの取得に失敗しました。");
  return data ? toDraft(data as Record<string, unknown>) : null;
}

export interface SalonOnboarding {
  serviceStatus: ServiceStatus;
  registrationSource: RegistrationSource;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  ownerEmail: string | null;
  ownerEmailConfirmed: boolean;
  ownerVerified: boolean;
  ownerVerificationMethod: "legacy" | "password_confirmed" | "password_set" | null;
  hasInvitation: boolean;
  lastKind: InvitationKind | null;
  lastAttemptAt: string | null;
  lastResult: "sending" | "accepted" | "failed" | "simulated" | null;
  lastError: string | null;
  lastAcceptedAt: string | null;
  firstAcceptedAt: string | null;
  attempts24h: number;
  nextSendAt: string | null;
  entitlementVersion: number;
}

export async function getSalonOnboarding(salonId: string): Promise<SalonOnboarding | null> {
  const { data, error } = await getSupabaseAdmin().rpc("admin_salon_onboarding", { p_salon_id: salonId });
  if (error) throw new Error("利用区分・招待の状態の取得に失敗しました。");
  const r = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (!r) return null;
  const method = r.owner_verification_method;
  return {
    serviceStatus: isServiceStatus(r.service_status) ? r.service_status : "pending",
    registrationSource: isRegistrationSource(r.registration_source) ? r.registration_source : "self_signup",
    contactName: (r.contact_name as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    contactPhone: (r.contact_phone as string | null) ?? null,
    ownerEmail: (r.owner_email as string | null) ?? null,
    ownerEmailConfirmed: Boolean(r.owner_email_confirmed),
    ownerVerified: Boolean(r.owner_verified),
    ownerVerificationMethod: method === "legacy" || method === "password_confirmed" || method === "password_set" ? method : null,
    hasInvitation: Boolean(r.has_invitation),
    lastKind: (r.last_kind as InvitationKind | null) ?? null,
    lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
    lastResult: (r.last_result as SalonOnboarding["lastResult"]) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    lastAcceptedAt: (r.last_accepted_at as string | null) ?? null,
    firstAcceptedAt: (r.first_accepted_at as string | null) ?? null,
    attempts24h: Number(r.attempts_24h ?? 0),
    nextSendAt: (r.next_send_at as string | null) ?? null,
    entitlementVersion: Number(r.entitlement_version ?? 0),
  };
}
