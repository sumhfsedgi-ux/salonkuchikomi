import type { SalonPlan } from "@/lib/access/plan";
import type { OverrideMode } from "@/lib/features/entitlements";
import { FEATURE_REGISTRY, type FeatureKey } from "@/lib/features/registry";
import { authEmailErrorLabel } from "@/lib/onboarding/authEmailErrors";
import { isServiceActive, serviceStatusLabel, SERVICE_STOPPED_LABEL, TEST_SEND_NOTICE, type RegistrationSource, type ServiceStatus } from "@/lib/onboarding/serviceStatus";
import { PLAN_LABELS } from "@/lib/ops/labels";
import { previewServiceAccess, type CatalogEntry, type PlanRules } from "@/lib/ops/preview";

/**
 * プランの表示(運営の画面。お客様の画面にはプランを出さない)。salons.plan の意味は区分で変わる(0026):
 *   利用中 → 契約プラン / 利用開始待ちの既存の店舗(止めている)→ 契約プラン(利用停止中)
 *   利用開始待ち → 案内予定のプラン(契約ではない)/ 仮の値(plan_placeholder)→ 未定
 * 予定のプランを「現在の契約」と表示しないため、プランを出す場所はすべてこれを使う。
 */
export interface PlanDisplay {
  kind: "contract" | "contract_stopped" | "planned" | "unset";
  /** 契約・予定のプラン(未定なら null)。 */
  plan: SalonPlan | null;
  /** 項目名(契約プラン / 案内予定のプラン / プラン)。 */
  label: string;
  /** 値の表示。 */
  text: string;
}

export function planDisplay(s: { plan: SalonPlan; planPlaceholder: boolean; serviceStatus: ServiceStatus; registrationSource: RegistrationSource }): PlanDisplay {
  if (isServiceActive(s.serviceStatus) && !s.planPlaceholder) {
    return { kind: "contract", plan: s.plan, label: "契約プラン", text: PLAN_LABELS[s.plan] };
  }
  if (s.planPlaceholder) return { kind: "unset", plan: null, label: "プラン", text: "未定" };
  if (s.registrationSource === "existing") {
    return { kind: "contract_stopped", plan: s.plan, label: "契約プラン", text: `${PLAN_LABELS[s.plan]}(利用停止中)` };
  }
  return { kind: "planned", plan: s.plan, label: "案内予定のプラン", text: `${PLAN_LABELS[s.plan]}(契約ではありません)` };
}

// 運営の画面の「利用区分」「招待と案内」の言葉(DBに触れない)。
// 招待の状態と利用区分は別に出す(招待が済んでも、利用を許可したことにはならない)。
// 送信の受付は「届いた」「読まれた」「利用開始済み」とは書かない。

export const INVITATION_KIND_LABELS = {
  invite: "招待(パスワードの設定)",
  salon_notice: "店舗登録のお知らせ(ログインのご案内)",
  verify_link: "本人確認のご案内(パスワードの設定)",
} as const;
export type InvitationKindKey = keyof typeof INVITATION_KIND_LABELS;

export const INVITATION_STATE_LABELS = {
  none: "お客様による登録",
  incomplete: "招待未完了",
  complete: "招待手続き完了",
} as const;

/** 「招待手続き完了」の判断の根拠(画面に出す)。 */
export const VERIFICATION_BASIS =
  "判断の根拠: 本人がメールのリンクを開き、パスワードを設定(または確認)した記録。メールを送っただけでは完了になりません。";

export interface VerificationInput {
  ownerEmailConfirmed: boolean;
  ownerVerified: boolean;
  ownerVerificationMethod: "legacy" | "password_confirmed" | "password_set" | null;
}

export function verificationText(v: VerificationInput): { complete: boolean; label: string } {
  if (v.ownerVerified && v.ownerEmailConfirmed) {
    const how =
      v.ownerVerificationMethod === "password_set"
        ? "本人がパスワードを設定"
        : v.ownerVerificationMethod === "password_confirmed"
          ? "本人が登録済みのパスワードを確認"
          : "既存のアカウント(ログイン可能)";
    return { complete: true, label: `招待手続き完了(${how})` };
  }
  if (!v.ownerEmailConfirmed) return { complete: false, label: "招待未完了(メールアドレスの確認がまだ)" };
  return { complete: false, label: "招待未完了(パスワードの設定がまだ)" };
}

export interface InvitationStatusInput {
  lastKind: InvitationKindKey | null;
  lastAttemptAt: string | null;
  lastResult: "sending" | "accepted" | "failed" | "simulated" | null;
  lastError: string | null;
  lastAcceptedAt: string | null;
  firstAcceptedAt: string | null;
  attempts24h: number;
  nextSendAt: string | null;
}

/** 送信中のまま、これより長く結果が記録されていないものは「結果不明」とする(DB と同じ5分)。 */
export const SENDING_UNKNOWN_AFTER_MS = 5 * 60 * 1000;
export const DAILY_SEND_LIMIT = 10;

export function invitationStatusText(i: InvitationStatusInput, now: Date): {
  lastResultText: string | null;
  failure: string | null;
  canResend: boolean;
  waitSeconds: number;
} {
  let lastResultText: string | null = null;
  let failure: string | null = null;
  const kind = i.lastKind ? INVITATION_KIND_LABELS[i.lastKind] : "案内";
  if (i.lastResult === "accepted") lastResultText = `${kind}: 送信を受け付けました(届いたか・読まれたかは確認できません)`;
  else if (i.lastResult === "simulated") lastResultText = `${kind}: 検証モードのため送信していません`;
  else if (i.lastResult === "failed") {
    lastResultText = `${kind}: 送信できませんでした`;
    failure = authEmailErrorLabel(i.lastError);
  } else if (i.lastResult === "sending") {
    const stale = i.lastAttemptAt && now.getTime() - new Date(i.lastAttemptAt).getTime() > SENDING_UNKNOWN_AFTER_MS;
    lastResultText = stale ? `${kind}: 送信の結果を確認できませんでした(再送できます)` : `${kind}: 送信しています`;
  }
  const waitSeconds = i.nextSendAt ? Math.max(0, Math.ceil((new Date(i.nextSendAt).getTime() - now.getTime()) / 1000)) : 0;
  return { lastResultText, failure, canResend: waitSeconds === 0 && i.attempts24h < DAILY_SEND_LIMIT, waitSeconds };
}

/** 本登録・区分の変更のあとに使える機能(DB と同じ判定の予測)。準備中・提供終了・対象外は含めない。 */
export function usableFeatureLabels(
  catalog: Partial<Record<FeatureKey, CatalogEntry>>,
  rules: PlanRules,
  plan: SalonPlan,
  overrides: Partial<Record<FeatureKey, OverrideMode>>,
  status: ServiceStatus,
): string[] {
  return FEATURE_REGISTRY.filter((def) => def.entitlement === "catalog" && def.listed)
    .filter((def) => previewServiceAccess(catalog[def.key], rules, plan, def.key, overrides[def.key] ?? "inherit", status).allowed)
    .map((def) => def.label);
}

/** 利用区分の変更の確認画面に出す文。 */
export function serviceStatusChangeNotes(params: {
  from: ServiceStatus;
  to: ServiceStatus;
  before: string[];
  after: string[];
  reservationActive: boolean;
  /** 利用開始待ちから利用中にするとき、このときから契約プランとして使うプラン。 */
  startPlan?: SalonPlan | null;
  registrationSource?: RegistrationSource | null;
}): string[] {
  const { from, to, before, after, reservationActive, startPlan, registrationSource } = params;
  // 利用中から pending への変更は、運営による停止
  const toLabel = to === "pending" && isServiceActive(from) ? SERVICE_STOPPED_LABEL : serviceStatusLabel(to, registrationSource);
  const notes: string[] = [`利用区分: ${serviceStatusLabel(from, registrationSource)} → ${toLabel}`];
  if (from === "pending" && isServiceActive(to) && startPlan) {
    notes.push(`【契約プラン】${PLAN_LABELS[startPlan]}を、このときから契約プランとして使います(お申し込み手続き中の間は、契約ではありませんでした)。`);
  }
  // 利用停止中にすると機能が止まる。結果をぼかさずに書く
  if (to === "pending") {
    notes.push("【利用停止中にすると】この店舗では、サービスの機能が使えなくなります(お客様用ページも「現在ご利用いただけません」になります)。登録内容やデータは消えません。");
  }
  notes.push(after.length > 0 ? `変更のあとに使える機能: ${after.join("・")}` : "変更のあとに使える機能: ありません");
  const lost = before.filter((l) => !after.includes(l));
  if (lost.length > 0) notes.push(`【使えなくなります】${lost.join("・")}`);
  notes.push("契約プランと機能の利用許可は変わりません。権限による停止も、この操作では解除しません。");
  notes.push("予約通知は、連携と開始の設定が完了するまで送信されません(この操作で自動では開始・再開しません)。");
  if (to === "pending" && reservationActive) notes.push("予約通知が稼働中のため、利用停止中にすると「権限による停止」になります。利用中に戻しても自動では再開しません。");
  if (to === "test") notes.push(TEST_SEND_NOTICE);
  return notes;
}
