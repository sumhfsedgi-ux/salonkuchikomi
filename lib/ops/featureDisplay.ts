import type { SalonPlan } from "@/lib/access/plan";
import type { EntitlementReason, OverrideMode } from "@/lib/features/entitlements";
import { PLAN_LABELS } from "@/lib/ops/labels";
import type { PlanRules } from "@/lib/ops/preview";

// 運営管理の「契約プラン・使える機能」に出す言葉(DBに触れない)。
// この欄で編集するのは利用許可だけで、実際に動いているか(通知中など)は「連携と稼働状況」で出す。
// 使えない理由は「使えません」と一括りにせず、プラン対象外・準備中・提供終了・許可しない、に分ける。
// 判定そのもの(順序・プランの制限)は DB と lib/ops/preview.ts が決め、ここでは言葉に直すだけにする。

export type AccessState = "allowed" | "not_allowed" | "not_in_plan" | "coming_soon" | "ended" | "service_pending";

export const ACCESS_STATE_LABELS: Record<AccessState, string> = {
  allowed: "利用を許可",
  not_allowed: "利用を許可しない",
  not_in_plan: "プラン対象外",
  coming_soon: "準備中",
  ended: "提供終了",
  service_pending: "利用開始待ち",
};

type Access = { allowed: boolean; reason: EntitlementReason };

/** 判定の結果を、画面の状態に直す(スイッチの横の文字・保存済みの状態・確認の見出しで共通に使う)。 */
export function accessState(a: Access): AccessState {
  if (a.allowed) return "allowed";
  switch (a.reason) {
    case "not_in_plan":
      return "not_in_plan";
    case "lifecycle_coming_soon":
      return "coming_soon";
    case "lifecycle_ended":
      return "ended";
    case "service_pending":
      return "service_pending";
    default:
      // 個別に許可しない(override_deny)・プラン内で許可していない(plan_default_off)・カタログに無い
      return "not_allowed";
  }
}

/** その機能を対象にしているプラン(表示順)。 */
export function plansIncluding(rules: PlanRules, key: string): SalonPlan[] {
  return (Object.keys(PLAN_LABELS) as SalonPlan[]).filter((p) => rules[p]?.[key] !== undefined);
}

function planList(plans: SalonPlan[]): string {
  return plans.map((p) => PLAN_LABELS[p]).join("・");
}

/**
 * プラン選択欄の説明。対象機能は機能カタログのプランの対象(plan_feature_rules)から作る(機能名で分岐しない)。
 * プランを変えれば必ず使える、とは書かない(個別設定・提供状態で使えない場合がある)。
 */
export function planNote(features: ReadonlyArray<{ key: string; label: string }>, rules: PlanRules): string {
  const inReviews = features.filter((f) => rules.reviews?.[f.key] !== undefined).map((f) => f.label);
  const onlyPack = features.filter((f) => rules.reviews?.[f.key] === undefined && rules.salonpack?.[f.key] !== undefined).map((f) => f.label);
  const first = inReviews.length > 0 ? `${PLAN_LABELS.reviews}の対象機能は${inReviews.join("・")}です。` : `${PLAN_LABELS.reviews}の対象機能はありません。`;
  return onlyPack.length > 0 ? `${first}${onlyPack.join("・")}の利用を許可する場合は、${PLAN_LABELS.salonpack}を選択してください。` : first;
}

/** プラン対象外の機能の補足(どのプランへ変えれば許可できるか)。提供中でない機能には「許可できます」と書かない。 */
export function notInPlanHint(plansWithFeature: SalonPlan[], lifecycleAvailable: boolean): string | null {
  if (plansWithFeature.length === 0) return null;
  if (!lifecycleAvailable) return `${planList(plansWithFeature)}の対象機能ですが、提供していないため利用を許可できません。`;
  return `${planList(plansWithFeature)}への変更で利用を許可できます。`;
}

/**
 * プラン対象外の機能に残っている個別設定の説明。設定は消さずに残り、対象プランへ戻したときに効く
 * (DB の salon_feature_access は、対象プランの外では個別設定を見ない)。
 */
export function retainedOverrideText(override: Exclude<OverrideMode, "inherit">, plansWithFeature: SalonPlan[]): string {
  const value = override === "deny" ? ACCESS_STATE_LABELS.not_allowed : ACCESS_STATE_LABELS.allowed;
  const where = plansWithFeature.length > 0 ? planList(plansWithFeature) : "対象プラン";
  return `以前の個別設定「${value}」が保存されています。${where}へ戻したときに適用されます。`;
}

/** 動き続ける機能・連携が必要な機能の前提(許可しただけでは始まらないこと)。前提が無ければ null。 */
export function startNote(label: string, prerequisites: string[], hasRuntime: boolean): string | null {
  if (hasRuntime) return `利用を許可しただけでは${label}は始まりません。${[...prerequisites, "開始の設定"].join("・")}が必要です。`;
  if (prerequisites.length > 0) return `利用には${prerequisites.join("・")}が必要です。`;
  return null;
}

/**
 * 未保存の変更で、保存すると何が変わるか(「未保存の変更:」に続ける文)。変更が無ければ null。
 * 理由(プランの変更・許可の取り消し・提供状態)ごとに書き分け、停止の影響はぼかさない。
 */
export function unsavedChangeText(params: {
  label: string;
  before: Access;
  after: Access;
  beforeOverride: OverrideMode;
  afterOverride: OverrideMode;
  /** 権限による停止が開いている(許可しても自動で再開しない)。 */
  holdOpen: boolean;
}): string | null {
  const { label, before, after, beforeOverride, afterOverride, holdOpen } = params;
  const b = accessState(before);
  const a = accessState(after);
  if (b === a) {
    if (beforeOverride === afterOverride) return null;
    if (afterOverride === "inherit") return `保存すると、${label}の以前の個別設定を外し、プランの設定に戻します(利用できるかどうかは今は変わりません)。`;
    return `保存すると、${label}の個別設定が変わります(利用できるかどうかは変わりません)。`;
  }
  switch (a) {
    case "not_in_plan":
      // プランの変更と同時に「プランの設定に戻す」を選んだときは、両方を書く。
      return `保存すると、${label}はプラン対象外になります。${beforeOverride !== "inherit" && afterOverride === "inherit" ? "以前の個別設定も外し、プランの設定に戻します。" : ""}`;
    case "allowed":
      return `保存すると、${label}の利用を許可します。${holdOpen ? "権限による停止は残るため、それだけでは再開しません。" : ""}`;
    case "not_allowed":
      if (b === "allowed") return `保存すると、${label}の利用許可が取り消されます。`;
      if (b === "not_in_plan") {
        return afterOverride === "deny"
          ? `保存すると、${label}は対象プランになりますが、保存されている個別設定「${ACCESS_STATE_LABELS.not_allowed}」が適用され、利用は許可されません。`
          : `保存すると、${label}は対象プランになりますが、このプランでは利用を許可していません。`;
      }
      return `保存すると、${label}は「${ACCESS_STATE_LABELS.not_allowed}」になります。`;
    case "coming_soon":
    case "ended":
      if (b === "not_in_plan") return `保存すると、${label}は対象プランになりますが、${ACCESS_STATE_LABELS[a]}のため利用できません。`;
      return `保存すると、${label}は${ACCESS_STATE_LABELS[a]}のため利用できなくなります。`;
    case "service_pending":
      return `保存すると、${label}の利用を許可します。利用開始待ちのため、使えるようになるのは利用開始のあとです。`;
  }
}
