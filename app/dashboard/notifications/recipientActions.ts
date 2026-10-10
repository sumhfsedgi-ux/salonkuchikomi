"use server";

import { revalidatePath } from "next/cache";
import { resolveAccessibleSalon } from "@/lib/notifications/access";
import { getLineLoginConfig } from "@/lib/notifications/line/login/config";
import {
  generateInviteToken,
  hashInviteToken,
  inviteQrDataUrl,
  inviteUrl,
  normalizeDisplayName,
} from "@/lib/notifications/recipients/invites";
import { createInvite, reissueInvite, removeRecipient, revokeInvite, updateRecipient } from "@/lib/notifications/recipients/db";
import { LOCKED_SETTING_MESSAGE } from "@/lib/notifications/recipients/messages";
import { logSafeError } from "@/lib/google/safeError";

// LINE 通知先・招待の操作(店舗のオーナーだけ。lib/notifications/access.ts)。
// 店舗の id はセッションから決め、通知先・招待の id はクライアントから受け取るが、DB 関数の中で店舗と一致するかを
// 確かめる(他の店舗の通知先・招待は変更できない)。通知先の追加・変更・解除は LINE の送信先だけを変え、
// 店舗の運用状態・Google 連携・契約・旧サービスの切り替えの状態には触れない。
// 招待の値はこの応答でだけ返す(DB にはハッシュだけ。ログにも出さない)。

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface IssuedInvite {
  url: string;
  qrDataUrl: string;
  expiresAt: string;
  displayName: string;
}

const NOT_AVAILABLE = "LINEの通知先の追加は準備中です。運営にお問い合わせください。";
const SAVE_FAILED = "保存に失敗しました。もう一度お試しください。";

async function issue(displayName: string, create: (tokenHash: string) => Promise<{ ok: boolean; expiresAt?: string | null; error?: string }>): Promise<Result<{ invite: IssuedInvite }>> {
  const config = getLineLoginConfig();
  if (!config) return { ok: false, error: NOT_AVAILABLE };
  const token = generateInviteToken();
  const created = await create(hashInviteToken(token));
  if (!created.ok || !created.expiresAt) return { ok: false, error: created.error ?? SAVE_FAILED };
  const url = inviteUrl(process.env.NEXT_PUBLIC_APP_URL!, token);
  return { ok: true, invite: { url, qrDataUrl: await inviteQrDataUrl(url), expiresAt: created.expiresAt, displayName } };
}

export async function createInviteAction(displayNameInput: string): Promise<Result<{ invite: IssuedInvite }>> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;
  const displayName = normalizeDisplayName(displayNameInput);
  if (!displayName) return { ok: false, error: "表示名を1〜40文字で入力してください。" };
  try {
    const result = await issue(displayName, async (tokenHash) => {
      const created = await createInvite({ salonId: resolved.salon.id, tokenHash, displayName, userId: resolved.userId });
      return created.ok
        ? { ok: true, expiresAt: created.expiresAt }
        : { ok: false, error: "有効な招待が多すぎます。使わない招待を取り消してから作成してください。" };
    });
    revalidatePath("/dashboard/notifications");
    return result;
  } catch (error) {
    logSafeError("recipients/createInvite", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function reissueInviteAction(inviteId: string): Promise<Result<{ invite: IssuedInvite }>> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;
  try {
    let displayName = "";
    const result = await issue("", async (tokenHash) => {
      const reissued = await reissueInvite({ salonId: resolved.salon.id, inviteId, tokenHash, userId: resolved.userId });
      if (reissued.outcome === "reissued") {
        displayName = reissued.displayName ?? "";
        return { ok: true, expiresAt: reissued.expiresAt };
      }
      if (reissued.outcome === "already_used") return { ok: false, error: "この招待はすでに使われています。" };
      if (reissued.outcome === "too_many") return { ok: false, error: "有効な招待が多すぎます。使わない招待を取り消してください。" };
      return { ok: false, error: "招待が見つかりません。" };
    });
    if (result.ok) result.invite.displayName = displayName;
    revalidatePath("/dashboard/notifications");
    return result;
  } catch (error) {
    logSafeError("recipients/reissueInvite", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function revokeInviteAction(inviteId: string): Promise<Result> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;
  try {
    const outcome = await revokeInvite(resolved.salon.id, inviteId, resolved.userId);
    revalidatePath("/dashboard/notifications");
    if (outcome === "revoked" || outcome === "already_revoked") return { ok: true };
    if (outcome === "already_used") return { ok: false, error: "この招待はすでに使われています。" };
    return { ok: false, error: "招待が見つかりません。" };
  } catch (error) {
    logSafeError("recipients/revokeInvite", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function updateRecipientAction(
  connectionId: string,
  patch: { newReservationEnabled?: boolean; cancellationEnabled?: boolean; label?: string }
): Promise<Result> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;
  let label: string | undefined;
  if (patch.label !== undefined) {
    const normalized = normalizeDisplayName(patch.label);
    if (!normalized) return { ok: false, error: "表示名を1〜40文字で入力してください。" };
    label = normalized;
  }
  try {
    const outcome = await updateRecipient({
      salonId: resolved.salon.id,
      connectionId,
      newReservationEnabled: patch.newReservationEnabled,
      cancellationEnabled: patch.cancellationEnabled,
      label,
    });
    revalidatePath("/dashboard/notifications");
    if (outcome === "updated") return { ok: true };
    if (outcome === "locked") return { ok: false, error: LOCKED_SETTING_MESSAGE };
    if (outcome === "invalid_label") return { ok: false, error: "表示名を1〜40文字で入力してください。" };
    return { ok: false, error: "通知先が見つかりません。" };
  } catch (error) {
    logSafeError("recipients/update", error);
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function removeRecipientAction(connectionId: string): Promise<Result> {
  const resolved = await resolveAccessibleSalon();
  if (!resolved.ok) return resolved;
  try {
    const outcome = await removeRecipient(resolved.salon.id, connectionId, `owner:${resolved.userId}`);
    revalidatePath("/dashboard/notifications");
    if (outcome === "removed") return { ok: true };
    if (outcome === "locked") return { ok: false, error: LOCKED_SETTING_MESSAGE };
    return { ok: false, error: "通知先が見つかりません。" };
  } catch (error) {
    logSafeError("recipients/remove", error);
    return { ok: false, error: SAVE_FAILED };
  }
}
