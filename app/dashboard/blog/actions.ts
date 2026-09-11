"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { updatePost } from "@/lib/blog/queries";

/**
 * STEP2でのタイトル・本文の手動編集を、一括コピーの直前にのみ確定保存する。
 * キー入力のたびにDBへ同期する必要はない（コピーした内容＝履歴の内容、を保証すれば十分）。
 *
 * 認証済みユーザー -> getCurrentSalon() -> salon.id の順で必ず解決し、
 * クライアントからsalonIdを受け取ることはしない。
 */
export async function saveDraftContentAction(postId: string, title: string, body: string) {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return;

  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle || !trimmedBody) return;
  await updatePost(salon.id, postId, { title: trimmedTitle, body: trimmedBody });
}
