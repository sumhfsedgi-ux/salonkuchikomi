import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { resolveFeatureSalon } from "@/lib/access/featureAccess";
import { getGbpInbox } from "@/lib/gbp/runtime";
import type { GbpInbox, SourceContext } from "@/lib/gbp/inbox";
import type { OwnerSalon } from "@/lib/types";

// 届いた口コミ(google_reviews)の入口の判定(計画 第2版 §3-8)。画面・Server Action・API のすべてがここを通る。
//   ① ログイン中のユーザー → その店舗(getCurrentSalon)。salon_id はクライアントから受け取らない。
//   ② 店舗の利用可否(DB の機能カタログ・プラン・店舗ごとの許可・利用区分。lib/access/featureAccess.ts)と、
//      GOOGLE_REVIEWS_OAUTH_ENABLED(lib/features/access.ts の二重の停止)とユーザーの権限。
//   ③ 口コミのサーバー処理(lib/gbp/runtime.ts。フラグが無効・鍵が無いときは null)。
// どれかが欠けたら使えない。期限切れの内容の削除だけは、ここを通さない(app/api/jobs/gbp-maintenance)。

export type GoogleReviewsAccess =
  | { ok: true; salon: OwnerSalon; userId: string; ctx: SourceContext; inbox: GbpInbox }
  | { ok: false; error: string };

const UNAVAILABLE = "届いた口コミは現在ご利用いただけません。";

/** その時点の判定(キャッシュしない)。時間のかかる処理のあとに確かめ直すときに使う。 */
export async function checkGoogleReviewsAccess(): Promise<GoogleReviewsAccess> {
  const supabase = await createClient();
  const resolved = await resolveFeatureSalon(supabase, "google_reviews");
  if (!resolved.ok) return resolved;
  const inbox = getGbpInbox();
  if (!inbox) return { ok: false, error: UNAVAILABLE };
  return {
    ok: true,
    salon: resolved.salon,
    userId: resolved.userId,
    ctx: { salonId: resolved.salon.id, userId: resolved.userId },
    inbox,
  };
}

/** 1回のリクエストの中で、layout・page・Server Action が同じ結果を使えるようにする。 */
export const resolveGoogleReviewsAccess = cache(checkGoogleReviewsAccess);
