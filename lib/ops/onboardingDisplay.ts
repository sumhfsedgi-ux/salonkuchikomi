import type { SalonPlan } from "@/lib/access/plan";
import type { OverrideMode } from "@/lib/features/entitlements";
import { FEATURE_REGISTRY, type FeatureKey } from "@/lib/features/registry";
import { authEmailErrorLabel } from "@/lib/onboarding/authEmailErrors";
import { SERVICE_STATUS_LABELS, type ServiceStatus } from "@/lib/onboarding/serviceStatus";
import { previewServiceAccess, type CatalogEntry, type PlanRules } from "@/lib/ops/preview";

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
  "判断の根拠: 本人がメールのリンクでメールアドレスを確認し、パスワードを設定(または登録済みのパスワードを確認)した記録(SalonPack の本人確認の記録)。メールの送信を受け付けただけでは完了にしません。";

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
}): string[] {
  const { from, to, before, after, reservationActive } = params;
  const notes: string[] = [`利用区分: ${SERVICE_STATUS_LABELS[from]} → ${SERVICE_STATUS_LABELS[to]}`];
  notes.push(after.length > 0 ? `変更のあとに使える機能: ${after.join("・")}` : "変更のあとに使える機能: ありません");
  const lost = before.filter((l) => !after.includes(l));
  if (lost.length > 0) notes.push(`【使えなくなります】${lost.join("・")}`);
  notes.push("契約プラン・機能の利用許可・権限による停止は変わりません(この操作では解除しません)。");
  notes.push("予約通知は、この操作では自動で開始・再開しません(お客様の連携と開始の操作、停止の解除が必要です)。");
  if (to === "pending" && reservationActive) notes.push("予約通知が稼働中のため、利用開始待ちにすると「権限による停止」になります。利用中に戻しても自動では再開しません。");
  if (to === "test") notes.push("テスト店舗でも、機能や権限は広がりません。メールや LINE の送信も自動では始まりません。");
  return notes;
}
