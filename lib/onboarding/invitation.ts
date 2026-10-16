import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendInvite, sendSalonNotice, sendVerificationLink, type AuthEmailDeps, type AuthEmailOutcome } from "@/lib/onboarding/authEmail";

// 運営が登録した店舗の、初回の案内と再送(サーバー)。順に行う:
//   1. admin_invitation_begin: 制限(60秒・24時間で10回)を確かめ、種類を決め、試行を記録する
//   2. 種類に応じたメールを送る(送らない環境では送らない)
//   3. admin_invitation_finish: 結果を記録する(履歴にも書く)
// 「送信を受け付けた」は Supabase が受け付けたという意味で、届いた・読まれた・利用を始めた、という意味ではない。
// 本人確認が済んでいても、店舗登録のお知らせは送る(「完了しているので送らない」とはしない)。

export type InvitationKind = "invite" | "salon_notice" | "verify_link";

export type InvitationSendResult =
  | { status: "accepted" | "simulated"; kind: InvitationKind }
  | { status: "failed"; kind: InvitationKind; code: string }
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "daily_limit" | "no_invitation" | "owner_changed" | "not_operator" | "error" };

interface BeginResult {
  result: string;
  attempt_id?: string;
  kind?: InvitationKind;
  email?: string;
  retry_after_seconds?: number;
}

async function send(deps: AuthEmailDeps, kind: InvitationKind, email: string): Promise<AuthEmailOutcome> {
  try {
    if (kind === "invite") return await sendInvite(deps, email);
    if (kind === "salon_notice") return await sendSalonNotice(deps, email);
    return await sendVerificationLink(deps, email);
  } catch {
    return { outcome: "failed", code: "send_failed" };
  }
}

export async function sendInvitationNotice(
  deps: AuthEmailDeps & { admin: SupabaseClient },
  params: { operatorId: string; salonId: string; requestId: string },
): Promise<InvitationSendResult> {
  const { data, error } = await deps.admin.rpc("admin_invitation_begin", {
    p_actor_user_id: params.operatorId,
    p_salon_id: params.salonId,
    p_request_id: params.requestId,
  });
  if (error) return { status: "error" };
  const begin = data as BeginResult;
  if (begin.result === "cooldown") return { status: "cooldown", retryAfterSeconds: begin.retry_after_seconds ?? 60 };
  if (begin.result !== "ok" || !begin.attempt_id || !begin.kind || !begin.email) {
    const known = ["daily_limit", "no_invitation", "owner_changed", "not_operator"] as const;
    return { status: (known as readonly string[]).includes(begin.result) ? (begin.result as (typeof known)[number]) : "error" };
  }

  const sent = await send(deps, begin.kind, begin.email);
  const result = sent.outcome === "accepted" ? "accepted" : sent.outcome === "failed" ? "failed" : "simulated";
  const code = sent.outcome === "failed" ? sent.code : null;
  await deps.admin.rpc("admin_invitation_finish", {
    p_actor_user_id: params.operatorId,
    p_attempt_id: begin.attempt_id,
    p_result: result,
    p_error_code: code,
  });
  if (result === "failed") return { status: "failed", kind: begin.kind, code: code ?? "send_failed" };
  return { status: result, kind: begin.kind };
}

export const INVITATION_KIND_LABELS: Record<InvitationKind, string> = {
  invite: "招待(パスワードの設定)",
  salon_notice: "店舗登録のお知らせ(ログインのご案内)",
  verify_link: "本人確認のご案内(パスワードの設定)",
};
