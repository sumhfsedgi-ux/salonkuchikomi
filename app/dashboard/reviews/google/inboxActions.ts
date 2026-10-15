"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveGoogleReviewsAccess } from "@/lib/googleReviews/access";
import { INBOX_PATH, parseListQuery } from "@/lib/googleReviews/query";
import { listSalonGoogleBindings } from "@/lib/google/db/bindings";
import { GoogleConnectInputError, startGoogleConnect } from "@/lib/google/oauthFlow";
import type { OAuthPurpose } from "@/lib/google/db/oauthStates";
import { getGoogleFlowDeps } from "@/lib/google/runtime";
import { logSafeError } from "@/lib/google/safeError";
import type {
  ActionResult,
  ReplySubmitRequest,
  ReplySubmitResult,
  ReviewDetail,
  ReviewListQuery,
  ReviewListResult,
} from "@/lib/googleReviews/types";

// 届いた口コミの操作(計画 第2版 §2・§3)。どの操作も、先に resolveGoogleReviewsAccess で
// ログイン中のユーザーの店舗・利用可否(DB の google_reviews と GOOGLE_REVIEWS_OAUTH_ENABLED)を確かめる。
// 口コミの ID はクライアントから来るので、その店舗のデータの中でだけ探す(lib/gbp/inbox.ts と DB の関数が salon_id で絞る)。
// Google への返信は、画面の確認ダイアログが作った操作の ID(op_id)ごとに1回だけ送る。送る直前に、DB で
// 処理権・利用可否・選択の世代を、アプリで GOOGLE_REVIEWS_OAUTH_ENABLED を確かめる(lib/gbp/inbox.ts)。

const idSchema = z.string().uuid();
const DRAFT_MAX_CHARS = 5000;
const NOT_FOUND = "口コミが見つかりません。";

export async function listReviewsAction(query: ReviewListQuery, cursor: string | null): Promise<ReviewListResult> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { kind: "error", message: access.error };
  const safeQuery = parseListQuery({
    get: (name: string) => {
      const value = (query as unknown as Record<string, unknown> | null)?.[name];
      return typeof value === "string" ? value : null;
    },
  });
  const safeCursor = typeof cursor === "string" && /^\d{1,6}$/.test(cursor) ? cursor : null;
  return access.inbox.listReviews(access.ctx, safeQuery, safeCursor);
}

export async function refreshReviewsAction(): Promise<ActionResult<{ lastCheckedAt: string; syncIncomplete: boolean }>> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error };
  return access.inbox.refresh(access.ctx);
}

export async function checkReviewAction(id: string): Promise<ActionResult<ReviewDetail>> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error };
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: NOT_FOUND };
  return access.inbox.checkReview(access.ctx, parsed.data);
}

export async function setReviewSeenAction(id: string, seen: boolean): Promise<ActionResult> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error };
  const parsed = idSchema.safeParse(id);
  if (!parsed.success || typeof seen !== "boolean") return { ok: false, error: NOT_FOUND };
  return access.inbox.setSeen(access.ctx, parsed.data, seen);
}

export async function saveReviewDraftAction(id: string, text: string): Promise<ActionResult<{ savedAt: string }>> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error };
  const parsed = idSchema.safeParse(id);
  if (!parsed.success || typeof text !== "string") return { ok: false, error: "下書きを保存できませんでした。" };
  if ([...text].length > DRAFT_MAX_CHARS) return { ok: false, error: "下書きが長すぎます。" };
  return access.inbox.saveDraft(access.ctx, parsed.data, text);
}

const submitSchema = z.object({
  reviewId: z.string().uuid(),
  opId: z.string().uuid(),
  action: z.enum(["upsert", "delete"]),
  text: z.string().max(20000).nullable(),
  expectedReply: z.string().max(20000).nullable(),
});

export async function submitReplyAction(request: ReplySubmitRequest): Promise<ReplySubmitResult> {
  const access = await resolveGoogleReviewsAccess();
  // 利用できない(準備中・許可が無い・ログインが切れた)ときは送らない。
  if (!access.ok) return { kind: "unavailable", message: `${access.error}返信は送っていません。` };
  const parsed = submitSchema.safeParse(request);
  if (!parsed.success) return { kind: "failed", message: "送る内容を確認できませんでした。画面を読み込み直してください。", retryable: false };
  try {
    return await access.inbox.submitReply(access.ctx, parsed.data);
  } catch {
    // どこまで進んだか分からない(送ったかもしれない)。成功とも失敗とも言わず、取り直して確かめるまで送り直させない。
    console.warn("gbp: reply submit failed unexpectedly");
    return {
      kind: "unknown",
      message:
        "送信の結果を確認できませんでした。返信が反映されているかもしれません。「Googleで確認する」で確かめてください。確認できるまで、もう一度送らないでください。",
    };
  }
}

export async function dismissReplyOperationAction(id: string): Promise<ActionResult> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error };
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: NOT_FOUND };
  return access.inbox.dismissReplyOperation(access.ctx, parsed.data);
}

/**
 * 口コミを受け取る店舗(ロケーション)を選ぶ。連携の前の同意がまだ記録されていない(Google連携の画面から連携した)ときは、
 * この画面の同意のチェックを必須にし、先に記録してから選ぶ(同意の無いまま口コミを取り込まない)。
 */
export async function selectLocationAction(input: { locationName: string; consent: boolean }): Promise<ActionResult> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error };
  const locationName = typeof input?.locationName === "string" ? input.locationName : "";
  if (!/^locations\/[^/\s]{1,100}$/.test(locationName)) return { ok: false, error: "選んだビジネスが見つかりません。" };
  if (!(await access.inbox.hasConsent(access.ctx))) {
    if (input.consent !== true) return { ok: false, error: "口コミの取り扱いについて確認し、チェックを入れてください。" };
    const recorded = await access.inbox.recordConsent(access.ctx);
    if (!recorded.ok) return recorded;
  }
  const result = await access.inbox.selectLocation(access.ctx, locationName);
  if (result.ok) {
    revalidatePath(INBOX_PATH, "layout");
    revalidatePath("/dashboard/settings/google");
  }
  return result;
}

type ConnectMode = "connect" | "same_account" | "add_scope" | "reauth" | "switch_account";
const CONNECT_MODES: readonly ConnectMode[] = ["connect", "same_account", "add_scope", "reauth", "switch_account"];

/**
 * 届いた口コミの画面から、共通の Google 連携を始める(口コミの権限だけを求める。戻り先はこの画面)。
 *   connect      : 新しく連携する(Google でアカウントを選ぶ)
 *   same_account : 予約メール(Gmail)と同じ Google アカウントに、口コミの権限を追加する
 *   add_scope    : 口コミの権限が足りないので、連携中のアカウントに追加する
 *   reauth       : 連携中のアカウントで再接続する
 *   switch_account: 店舗を選ぶ前に、別の Google アカウントで確かめる(口コミの結び付けだけを切り替える)
 * 初めての連携(connect・same_account)は、同意のチェックを記録してから Google へ移る。
 */
export async function startReviewsConnectAction(formData: FormData): Promise<void> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) redirect(`${INBOX_PATH}?google=not_available`);
  const modeRaw = String(formData.get("mode") ?? "connect");
  const mode: ConnectMode = (CONNECT_MODES as readonly string[]).includes(modeRaw) ? (modeRaw as ConnectMode) : "connect";

  const bindings = await listSalonGoogleBindings(access.salon.id);
  const gbp = bindings.find((b) => b.feature === "gbp");
  const gmail = bindings.find((b) => b.feature === "gmail");

  let purpose: OAuthPurpose = "connect";
  let source: typeof gbp = undefined;
  if (mode === "reauth" || mode === "add_scope") {
    if (!gbp) redirect(`${INBOX_PATH}?google=not_connected`);
    purpose = mode;
    source = gbp;
  } else if (mode === "switch_account") {
    if (!gbp) redirect(`${INBOX_PATH}?google=not_connected`);
    purpose = "switch_account";
  } else if (mode === "same_account") {
    if (!gmail) redirect(`${INBOX_PATH}?google=not_connected`);
    purpose = "add_scope";
    source = gmail;
  }

  if (mode === "connect" || mode === "same_account") {
    if (formData.get("consent") !== "yes") redirect(`${INBOX_PATH}?google=consent_required`);
    const recorded = await access.inbox.recordConsent(access.ctx);
    if (!recorded.ok) redirect(`${INBOX_PATH}?google=start_failed`);
  }

  let url: string;
  try {
    url = await startGoogleConnect(
      {
        salonId: access.salon.id,
        userId: access.userId,
        features: ["gbp"],
        purpose,
        expectedGoogleSub: source?.account.googleSub ?? null,
        loginHint: source ? (source.accountEmail ?? source.account.email) : null,
        returnTo: "reviews",
      },
      getGoogleFlowDeps(),
    );
  } catch (error) {
    if (error instanceof GoogleConnectInputError) redirect(`${INBOX_PATH}?google=not_available`);
    logSafeError("gbp/start", error);
    redirect(`${INBOX_PATH}?google=start_failed`);
  }
  redirect(url);
}
