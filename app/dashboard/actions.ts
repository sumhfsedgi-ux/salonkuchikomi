"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { applyDefaultBusinessType } from "@/lib/supabase/queries";
import { resolveFeatureSalon } from "@/lib/access/featureAccess";
import { getPlanExperience } from "@/lib/features/access";

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// 店舗の作成は、お客様は app/onboarding/actions.ts(create_own_salon)、運営は app/ops/salons/drafts/actions.ts
// (admin_register_salon)だけで行う(0025。ブラウザから salons に直接 INSERT するポリシーは無い)。

export async function startSurveyAction(
  salonId: string,
  templateId: string | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "ログインが必要です。" };
  // 口コミ(アンケート)を使える店舗だけ(契約・提供状況の判定は lib/features/access.ts と共通)。
  const access = await resolveFeatureSalon(supabase, "reviews");
  if (!access.ok) return { error: access.error };

  // Uses restart_survey_from_template (not create_survey_from_template)
  // because the onboarding wizard lets the owner go back to STEP2 and pick a
  // different template after a survey already exists (STEP3 -> STEP2). That
  // RPC deactivates any existing active survey first, so it's a safe
  // superset of "create" that also works the very first time (nothing to
  // deactivate yet). RLS (owner_insert/owner_update policies on
  // surveys/questions/question_options) is what actually stops this from
  // touching a salon the caller doesn't own, even though salonId here comes
  // from the client.
  const { error } = await supabase.rpc("restart_survey_from_template", {
    p_salon_id: salonId,
    p_template_id: templateId,
  });

  if (error) {
    console.error("startSurveyAction failed", error);
    return { error: "アンケートの作成に失敗しました。もう一度お試しください。" };
  }

  await applyDefaultBusinessType(supabase, salonId, templateId);

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/reviews");
  revalidatePath("/dashboard/setup/reviews");
  return {};
}

// Marks the onboarding wizard as finished. This is the only place
// `onboarding_completed` is ever set to true, and it's what keeps
// the dashboard home page from jumping straight to the dashboard as soon as
// a survey row exists (which happens as early as STEP2) -- see the plan doc
// for why that mattered. Resolves the caller's own salon server-side rather
// than trusting a client-supplied id, same as every other action here.
export async function completeOnboardingAction(
  googleReviewUrl: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const access = await resolveFeatureSalon(supabase, "reviews");
  if (!access.ok) return { error: access.error };
  const { salon } = access;

  const trimmed = googleReviewUrl.trim();
  if (trimmed.length > 500) {
    return { error: "Google口コミ投稿URLは500文字以内で入力してください。" };
  }

  const { error } = await supabase
    .from("salons")
    .update({
      google_review_url: trimmed || null,
      onboarding_completed: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", salon.id);

  if (error) {
    console.error("completeOnboardingAction failed", error);
    return { error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard");
  // 口コミプランは機能一覧のホームを使わず、口コミの設定画面へ進む(SalonPack はホームへ)。
  redirect(getPlanExperience(salon.plan) === "reviews_direct" ? "/dashboard/reviews?onboarded=1" : "/dashboard?onboarded=1");
}
