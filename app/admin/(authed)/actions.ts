"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon, applyDefaultBusinessType } from "@/lib/supabase/queries";
import { generateRandomSlug } from "@/lib/generateSlug";
import type { OwnerSalon } from "@/lib/types";

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

const salonInfoSchema = z.object({
  name: z.string().trim().min(1, "店舗名を入力してください").max(100),
});

const CREATE_SALON_MAX_ATTEMPTS = 5;

export async function createSalonAction(
  formData: FormData,
): Promise<{ error?: string; salon?: OwnerSalon }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "ログインが必要です。" };

  const parsed = salonInfoSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) return { error: "アカウント情報の取得に失敗しました。" };

  // The slug is a random string (salon names are Japanese and can't become
  // a readable URL segment) -- a collision is astronomically unlikely, but
  // retry with a fresh one on the rare unique-constraint hit rather than
  // failing the whole signup.
  for (let attempt = 0; attempt < CREATE_SALON_MAX_ATTEMPTS; attempt++) {
    const { data: inserted, error } = await supabase
      .from("salons")
      .insert({ owner_id: profile.id, name: parsed.data.name, slug: generateRandomSlug() })
      .select(
        "id, owner_id, name, slug, google_review_url, description, business_type, onboarding_completed, created_at, updated_at",
      )
      .single();

    if (!error && inserted) {
      revalidatePath("/admin");
      return {
        salon: {
          id: inserted.id,
          ownerId: inserted.owner_id,
          name: inserted.name,
          slug: inserted.slug,
          googleReviewUrl: inserted.google_review_url,
          description: inserted.description,
          businessType: inserted.business_type,
          onboardingCompleted: inserted.onboarding_completed,
          createdAt: inserted.created_at,
          updatedAt: inserted.updated_at,
        },
      };
    }
    if (error.code !== "23505") {
      console.error("createSalonAction failed", error);
      return { error: "店舗情報の登録に失敗しました。もう一度お試しください。" };
    }
  }
  return { error: "店舗情報の登録に失敗しました。もう一度お試しください。" };
}

export async function startSurveyAction(
  salonId: string,
  templateId: string | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "ログインが必要です。" };

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

  revalidatePath("/admin");
  revalidatePath("/admin/survey");
  return {};
}

// Marks the onboarding wizard as finished. This is the only place
// `onboarding_completed` is ever set to true, and it's what keeps
// AdminHomePage from jumping straight to the dashboard as soon as a survey
// row exists (which happens as early as STEP2) -- see the plan doc for why
// that mattered. Resolves the caller's own salon server-side rather than
// trusting a client-supplied id, same as every other action here.
export async function completeOnboardingAction(
  googleReviewUrl: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };

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

  revalidatePath("/admin");
  redirect("/admin?onboarded=1");
}
