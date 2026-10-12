import type { FeatureKey } from "@/lib/features/registry";

// 機能ごとの利用権限の判定結果(DB の salon_feature_access_all の1行)。DBに触れない型と変換だけを置く
// (読み込みは lib/features/loadEntitlements.ts)。
// 4つの軸を分けて持つ: 提供状態(lifecycle)/ 対象プラン(inPlan)/ プラン内の標準(defaultEnabled)/ 個別設定(override)。
// 最終的な利用可否(allowed)と理由(reason)は DB の関数がこの順に決めたもので、アプリは判定し直さない
// (画面・API・通知処理で同じ結果を使うため)。

export type FeatureLifecycle = "coming_soon" | "available" | "ended";
export type OverrideMode = "inherit" | "allow" | "deny";
export type EntitlementReason =
  | "unknown_feature"
  | "not_in_plan"
  | "lifecycle_coming_soon"
  | "lifecycle_ended"
  | "override_deny"
  | "override_allow"
  | "plan_default"
  | "plan_default_off";

export interface FeatureEntitlement {
  key: FeatureKey;
  lifecycle: FeatureLifecycle;
  /** 定期処理などで動き続ける機能(利用不可にしたら「権限による停止」を記録する)。 */
  hasRuntime: boolean;
  /** 店舗のプランが、この機能の対象プランか。 */
  inPlan: boolean;
  /** プラン内の標準設定(対象プランのときだけ意味がある)。 */
  defaultEnabled: boolean;
  override: OverrideMode;
  allowed: boolean;
  reason: EntitlementReason;
  /** 権限による停止が開いている(予約通知。運営が管理画面から解除するまで動かさない)。 */
  holdOpen: boolean;
}

export type SalonEntitlements = Partial<Record<FeatureKey, FeatureEntitlement>>;

export interface EntitlementRow {
  feature_key: string;
  lifecycle: string;
  has_runtime: boolean;
  in_plan: boolean;
  default_enabled: boolean;
  override_mode: string;
  allowed: boolean;
  reason: string;
  hold_open: boolean;
}

const LIFECYCLES: FeatureLifecycle[] = ["coming_soon", "available", "ended"];
const MODES: OverrideMode[] = ["inherit", "allow", "deny"];

/** DB の行を型に直す。知らない値は使わない側(利用不可)に倒す。 */
export function toSalonEntitlements(rows: EntitlementRow[], isKnownKey: (key: string) => key is FeatureKey): SalonEntitlements {
  const out: SalonEntitlements = {};
  for (const r of rows) {
    if (!isKnownKey(r.feature_key)) continue;
    const lifecycle = LIFECYCLES.includes(r.lifecycle as FeatureLifecycle) ? (r.lifecycle as FeatureLifecycle) : "coming_soon";
    const override = MODES.includes(r.override_mode as OverrideMode) ? (r.override_mode as OverrideMode) : "inherit";
    out[r.feature_key] = {
      key: r.feature_key,
      lifecycle,
      hasRuntime: r.has_runtime,
      inPlan: r.in_plan,
      defaultEnabled: r.default_enabled,
      override,
      allowed: r.allowed === true && lifecycle === "available",
      reason: r.reason as EntitlementReason,
      holdOpen: r.hold_open,
    };
  }
  return out;
}

/** 管理画面に出す、理由の説明(運営向け)。 */
export const ENTITLEMENT_REASON_LABELS: Record<EntitlementReason, string> = {
  unknown_feature: "機能カタログに登録されていません",
  not_in_plan: "この契約プランでは使えません",
  lifecycle_coming_soon: "準備中のため使えません",
  lifecycle_ended: "提供を終了したため使えません",
  override_deny: "停止にしています",
  override_allow: "利用中にしています",
  plan_default: "プランの標準で利用中",
  plan_default_off: "プランの標準では使えません",
};

export const LIFECYCLE_LABELS: Record<FeatureLifecycle, string> = {
  coming_soon: "準備中",
  available: "提供中",
  ended: "提供終了",
};

/** 保存する個別設定の表示名(管理画面ではスイッチの「利用中/停止」として扱う。lib/ops/toggle.ts)。 */
export const OVERRIDE_LABELS: Record<OverrideMode, string> = {
  inherit: "標準どおり",
  allow: "利用中",
  deny: "停止",
};
