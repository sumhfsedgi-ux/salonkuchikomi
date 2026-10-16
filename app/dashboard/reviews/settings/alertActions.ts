"use server";

import { revalidatePath } from "next/cache";
import { resolveGoogleReviewsAccess } from "@/lib/googleReviews/access";
import { isReviewAlertsEnabled } from "@/lib/reviews/alerts/config";
import {
  reviewAlertTestDestinations,
  setReviewRecipient,
  startReviewAlerts,
  stopReviewAlerts,
  takeReviewAlertTestSlot,
} from "@/lib/reviews/alerts/ownerOps";
import { reviewAlertTestText } from "@/lib/reviews/alerts/message";
import { getLineLoginConfig } from "@/lib/notifications/line/login/config";
import { generateInviteToken, hashInviteToken, inviteQrDataUrl, inviteUrl, normalizeDisplayName } from "@/lib/notifications/recipients/invites";
import { createInvite, reissueInvite, removeRecipient, revokeInvite } from "@/lib/notifications/recipients/db";
import { LOCKED_SETTING_MESSAGE, TEST_SEND_RESULT_MESSAGES } from "@/lib/notifications/recipients/messages";
import { isRealLineSendAllowed, resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";
import { LineSendBlockedError, pushText } from "@/lib/notifications/line/LineClient";
import { logSafeError } from "@/lib/google/safeError";

// 口コミの設定タブの「LINE通知」の操作。店舗はサーバーで解決し、Google口コミ(google_reviews)を使える店舗だけが使える。
//   - 開始・テスト通知・通知先の招待は REVIEW_ALERTS_ENABLED のときだけ(このデプロイで提供していなければ準備中)。
//   - 停止・通知先の OFF・解除・招待の取消は、いつでもできる(止める操作は止めない)。
//   - 通知先(line_connections)は予約通知と共通。招待・解除は予約通知の画面と同じ DB 関数を使う。
// 予約通知の稼働状態・Gmail の連携・Google アカウントの状態には触れない。

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ReviewIssuedInvite {
  url: string;
  qrDataUrl: string;
  expiresAt: string;
  displayName: string;
}

const PATH = "/dashboard/reviews/settings";
const SAVE_FAILED = "保存に失敗しました。もう一度お試しください。";
const NOT_AVAILABLE = "口コミのLINE通知は準備中です。";

const START_ERRORS: Record<string, string> = {
  changed: "ほかの画面で設定が変わりました。画面を読み込み直して、もう一度お試しください。",
  not_entitled: "Google口コミをご利用いただけないため、開始できません。",
  consent_required: "口コミの取り扱いの確認(同意)の更新が必要です。「口コミ」タブで内容を確認してください。",
  not_ready: "Google連携・店舗の選択・最初の取り込みが終わっていません。「口コミ」タブで続けてください。",
  no_recipients: "口コミ通知がONの通知先がいません。通知先の口コミ通知をONにしてから開始してください。",
};

function refresh() {
  revalidatePath(PATH);
  revalidatePath("/dashboard/notifications");
}

export async function startReviewAlertsAction(expectedVersion: number): Promise<Result> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  if (!isReviewAlertsEnabled()) return { ok: false, error: NOT_AVAILABLE };
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return { ok: false, error: START_ERRORS.changed };
  try {
    const outcome = await startReviewAlerts(access.salon.id, access.userId, expectedVersion);
    refresh();
    return outcome === "started" ? { ok: true } : { ok: false, error: START_ERRORS[outcome] ?? SAVE_FAILED };
  } catch (error) {
    logSafeError("reviewAlerts/start", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function stopReviewAlertsAction(): Promise<Result<{ message: string }>> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  try {
    const { inFlight } = await stopReviewAlerts(access.salon.id, access.userId);
    refresh();
    return {
      ok: true,
      message:
        inFlight > 0
          ? `停止しました。送信処理中だった${inFlight}件は取り消せないため、届く場合があります。`
          : "停止しました。停止中に投稿された口コミは、再開してもお知らせしません。",
    };
  } catch (error) {
    logSafeError("reviewAlerts/stop", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function setReviewRecipientAction(connectionId: string, enabled: boolean): Promise<Result> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  if (enabled && !isReviewAlertsEnabled()) return { ok: false, error: NOT_AVAILABLE };
  if (typeof connectionId !== "string" || typeof enabled !== "boolean") return { ok: false, error: "通知先が見つかりません。" };
  try {
    const outcome = await setReviewRecipient(access.salon.id, connectionId, enabled, access.userId);
    refresh();
    if (outcome === "not_found") return { ok: false, error: enabled ? "LINEが連携されている通知先だけをONにできます。" : "通知先が見つかりません。" };
    return { ok: true };
  } catch (error) {
    logSafeError("reviewAlerts/setRecipient", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

/**
 * テスト通知(ボタンなしの文)。口コミ通知が ON の通知先にだけ送る。本番以外は実際には送らない
 * (lib/notifications/line/sendPolicy.ts。送信の入口の pushText でも止まる)。配信の記録・再試行の対象にはしない。
 */
export async function sendReviewAlertTestAction(): Promise<Result<{ message: string }>> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  if (!isReviewAlertsEnabled()) return { ok: false, error: NOT_AVAILABLE };
  try {
    const destinations = await reviewAlertTestDestinations(access.salon.id);
    if (destinations.length === 0) return { ok: false, error: "口コミ通知がONの通知先がいません。" };
    const policy = resolveLineSendPolicy();
    const real = destinations.filter((d) => isRealLineSendAllowed(policy, d.destinationId));
    if (policy.mode === "simulated" || real.length === 0) return { ok: true, message: TEST_SEND_RESULT_MESSAGES.simulated };
    if (!(await takeReviewAlertTestSlot(access.salon.id))) return { ok: true, message: TEST_SEND_RESULT_MESSAGES[policy.mode] };

    const text = reviewAlertTestText(access.salon.name);
    let sent = 0;
    for (const d of real) {
      try {
        const { outcome } = await pushText(d.destinationId, text, crypto.randomUUID());
        if (outcome === "sent") sent++;
      } catch (error) {
        if (error instanceof LineSendBlockedError) continue;
        logSafeError("reviewAlerts/test", error);
      }
    }
    return sent > 0 ? { ok: true, message: TEST_SEND_RESULT_MESSAGES[policy.mode] } : { ok: false, error: "LINEへのテスト通知の送信に失敗しました。" };
  } catch (error) {
    logSafeError("reviewAlerts/test", error);
    return { ok: false, error: "LINEへのテスト通知の送信に失敗しました。" };
  }
}

async function issue(create: (tokenHash: string) => Promise<{ ok: true; expiresAt: string; displayName: string } | { ok: false; error: string }>): Promise<Result<{ invite: ReviewIssuedInvite }>> {
  if (!getLineLoginConfig()) return { ok: false, error: "LINEの通知先の追加は準備中です。運営にお問い合わせください。" };
  const token = generateInviteToken();
  const created = await create(hashInviteToken(token));
  if (!created.ok) return created;
  const url = inviteUrl(process.env.NEXT_PUBLIC_APP_URL!, token);
  return { ok: true, invite: { url, qrDataUrl: await inviteQrDataUrl(url), expiresAt: created.expiresAt, displayName: created.displayName } };
}

export async function createReviewInviteAction(displayNameInput: string): Promise<Result<{ invite: ReviewIssuedInvite }>> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  if (!isReviewAlertsEnabled()) return { ok: false, error: NOT_AVAILABLE };
  const displayName = normalizeDisplayName(displayNameInput);
  if (!displayName) return { ok: false, error: "表示名を1〜40文字で入力してください。" };
  try {
    const result = await issue(async (tokenHash) => {
      const created = await createInvite({ salonId: access.salon.id, tokenHash, displayName, userId: access.userId });
      return created.ok
        ? { ok: true, expiresAt: created.expiresAt, displayName }
        : { ok: false, error: "有効な招待が多すぎます。使わない招待を取り消してから作成してください。" };
    });
    refresh();
    return result;
  } catch (error) {
    logSafeError("reviewAlerts/createInvite", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function reissueReviewInviteAction(inviteId: string): Promise<Result<{ invite: ReviewIssuedInvite }>> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  if (!isReviewAlertsEnabled()) return { ok: false, error: NOT_AVAILABLE };
  try {
    const result = await issue(async (tokenHash) => {
      const r = await reissueInvite({ salonId: access.salon.id, inviteId, tokenHash, userId: access.userId });
      if (r.outcome === "reissued" && r.expiresAt) return { ok: true, expiresAt: r.expiresAt, displayName: r.displayName ?? "" };
      if (r.outcome === "already_used") return { ok: false, error: "この招待はすでに使われています。" };
      if (r.outcome === "too_many") return { ok: false, error: "有効な招待が多すぎます。使わない招待を取り消してください。" };
      return { ok: false, error: "招待が見つかりません。" };
    });
    refresh();
    return result;
  } catch (error) {
    logSafeError("reviewAlerts/reissueInvite", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function revokeReviewInviteAction(inviteId: string): Promise<Result> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  try {
    const outcome = await revokeInvite(access.salon.id, inviteId, access.userId);
    refresh();
    if (outcome === "revoked" || outcome === "already_revoked") return { ok: true };
    if (outcome === "already_used") return { ok: false, error: "この招待はすでに使われています。" };
    return { ok: false, error: "招待が見つかりません。" };
  } catch (error) {
    logSafeError("reviewAlerts/revokeInvite", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

/** 通知先の解除(予約通知と共通。解除すると、予約通知と口コミ通知の両方が届かなくなる)。 */
export async function removeReviewRecipientAction(connectionId: string): Promise<Result> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return access;
  try {
    const outcome = await removeRecipient(access.salon.id, connectionId, `owner:${access.userId}`);
    refresh();
    if (outcome === "removed") return { ok: true };
    if (outcome === "locked") return { ok: false, error: LOCKED_SETTING_MESSAGE };
    return { ok: false, error: "通知先が見つかりません。" };
  } catch (error) {
    logSafeError("reviewAlerts/removeRecipient", error);
    return { ok: false, error: SAVE_FAILED };
  }
}
