"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolveGoogleReviewsAccess } from "@/lib/googleReviews/access";
import { INBOX_PATH } from "@/lib/googleReviews/query";
import { replySettingsSchema, type ReplySettings } from "@/lib/replyGeneration/settings";
import { saveReplySettings } from "@/lib/replyGeneration/settingsRepo";

// 口コミの設定タブの操作。店舗はサーバーで解決し、届いた口コミ(google_reviews)を使える店舗だけが使える。
// 返信の設定を保存しても、作成中の返信案や Google に公開済みの返信は変わらない(次に作る案から使われる)。

export type SaveReplySettingsResult = { ok: true; settings: ReplySettings } | { ok: false; error: string };

export async function saveReplySettingsAction(input: ReplySettings): Promise<SaveReplySettingsResult> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) return { ok: false, error: access.error };
  const parsed = replySettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力内容を確認してください。" };

  let outcome: Awaited<ReturnType<typeof saveReplySettings>>;
  try {
    outcome = await saveReplySettings(getSupabaseAdmin(), access.salon.id, parsed.data);
  } catch {
    outcome = "failed";
  }
  if (outcome === "unavailable") return { ok: false, error: "返信の設定を保存できない状態です。しばらくしてからもう一度お試しください。" };
  if (outcome === "failed") return { ok: false, error: "保存できませんでした。もう一度お試しください。" };

  revalidatePath("/dashboard/reviews/settings");
  return { ok: true, settings: parsed.data };
}

/**
 * 口コミを受け取る店舗を選び直す。今の店舗の一時保存した口コミ・下書きは消える(確認のチェックが必要)。
 * Google には何も送らない。選び直しは届いた口コミの画面で行う。
 */
export async function changeLocationAction(formData: FormData): Promise<void> {
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) redirect("/dashboard/reviews/settings");
  if (formData.get("confirm") !== "yes") redirect("/dashboard/reviews/settings?location=confirm_required");
  const result = await access.inbox.beginLocationChange(access.ctx);
  if (!result.ok) redirect("/dashboard/reviews/settings?location=failed");
  revalidatePath(INBOX_PATH, "layout");
  revalidatePath("/dashboard/settings/google");
  redirect(INBOX_PATH);
}
