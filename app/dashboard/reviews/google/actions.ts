"use server";

import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isSimulatedGoogleEnabled } from "@/lib/google/config";
import { checkGoogleReviewsAccess, resolveGoogleReviewsAccess } from "@/lib/googleReviews/access";
import { CONNECTION_CHANGED_MESSAGE } from "@/lib/googleReviews/messages";
import { isStarRating } from "@/lib/replyGeneration/classify";
import { generateReplyForSalon, type ReplyServiceResult } from "@/lib/replyGeneration/service";

// 届いた口コミの1件から AI の返信案を作る(計画 第2版 §3-6・§3-A)。
//   ・画面からは口コミの ID と選択の世代(locationId)だけを受け取り、本文と★はサーバーがその店舗の一時保存から読む。
//     投稿者名は AI に送らない。本文の電話番号・メールアドレス・URL は伏せ字にしてから送る(lib/replyGeneration/service.ts)。
//   ・作り終えたら、その口コミがまだ同じ世代で使えるかを確かめ、違えば返信案を返さない(連携・店舗が変わった)。
//     画面も、受け取った結果の口コミ・世代が今の表示と違えば表示しない。
//   ・文章を作るのは OpenAI。架空の Google を使う検証(テスト用DBの架空モード)では、OpenAI を呼ばずに架空の文章にする。
//   ・返信案はどこにも保存しない(下書きの保存は、画面が編集の内容を別に保存する)。

export type GenerateForReviewResult =
  | ({ reviewId: string; locationId: string } & Extract<ReplyServiceResult, { ok: true }>)
  | { ok: false; error: string; retryable: boolean; reviewId: string; stale?: boolean };

const requestSchema = z.object({
  reviewId: z.string().uuid(),
  locationId: z.string().uuid(),
  previousReply: z.string().max(20000).nullable().optional(),
  regenerate: z.boolean().optional(),
});

const STALE = CONNECTION_CHANGED_MESSAGE;
const NO_RATING = "この口コミには★の評価が無いため、返信案を作成できません。返信を直接入力してください。";

function adminClientOrNull(): SupabaseClient | null {
  try {
    return getSupabaseAdmin();
  } catch {
    console.warn("reply generation: service role client unavailable; pausing generation");
    return null;
  }
}

export async function generateReplyForReviewAction(request: {
  reviewId: string;
  locationId: string;
  previousReply?: string | null;
  regenerate?: boolean;
}): Promise<GenerateForReviewResult> {
  const reviewId = typeof request?.reviewId === "string" ? request.reviewId : "";
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error, retryable: false, reviewId };
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, error: "入力内容を確認してください。", retryable: false, reviewId };
  const { inbox, ctx, salon } = access;

  const input = await inbox.getReplyInput(ctx, parsed.data.reviewId);
  if (!input.ok) return { ok: false, error: input.error, retryable: false, reviewId };
  if (input.value.locationId !== parsed.data.locationId) return { ok: false, error: STALE, retryable: false, reviewId, stale: true };
  const rating = input.value.rating;
  if (rating === null || !isStarRating(rating)) return { ok: false, error: NO_RATING, retryable: false, reviewId };

  const result = await generateReplyForSalon(
    {
      salon: { id: salon.id, name: salon.name, businessType: salon.businessType ?? null, description: salon.description ?? null },
      reviewText: input.value.text,
      rating,
      previousReply: parsed.data.previousReply ?? null,
      regenerate: parsed.data.regenerate === true,
    },
    { admin: adminClientOrNull(), mock: isSimulatedGoogleEnabled(), schedule: (task) => after(task) },
  );

  // 作っている間に、連携・店舗の変更・利用の停止が起きていないか(§3-A)。利用可否はキャッシュせずに確かめ直す。
  if (!(await inbox.isCurrent(ctx, parsed.data.reviewId, input.value.locationId))) {
    return { ok: false, error: STALE, retryable: false, reviewId, stale: true };
  }
  const again = await checkGoogleReviewsAccess();
  if (!again.ok) return { ok: false, error: again.error, retryable: false, reviewId };
  if (!result.ok) return { ...result, reviewId };
  return { ...result, reviewId, locationId: input.value.locationId };
}
