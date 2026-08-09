"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { OwnerSalon } from "@/lib/types";

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

const salonInfoSchema = z.object({
  name: z.string().trim().min(1, "店舗名を入力してください").max(100),
  slug: z
    .string()
    .trim()
    .min(1, "ページURLを入力してください")
    .max(60)
    .regex(/^[a-z0-9-]+$/, "ページURLは半角英数字とハイフンのみ使用できます"),
});

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
    slug: formData.get("slug"),
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

  const { data: inserted, error } = await supabase
    .from("salons")
    .insert({ owner_id: profile.id, name: parsed.data.name, slug: parsed.data.slug })
    .select("id, owner_id, name, slug, google_review_url, description, created_at, updated_at")
    .single();

  if (error || !inserted) {
    if (error?.code === "23505") {
      return { error: "このページURLはすでに使用されています。別のURLをお試しください。" };
    }
    console.error("createSalonAction failed", error);
    return { error: "店舗情報の登録に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin");

  return {
    salon: {
      id: inserted.id,
      ownerId: inserted.owner_id,
      name: inserted.name,
      slug: inserted.slug,
      googleReviewUrl: inserted.google_review_url,
      description: inserted.description,
      createdAt: inserted.created_at,
      updatedAt: inserted.updated_at,
    },
  };
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

  // RLS (owner_insert policies on surveys/questions/question_options) is what
  // actually stops this from creating a survey under a salon the caller
  // doesn't own, even though salonId here comes from the client.
  const { error } = await supabase.rpc("create_survey_from_template", {
    p_salon_id: salonId,
    p_template_id: templateId,
  });

  if (error) {
    console.error("startSurveyAction failed", error);
    return { error: "アンケートの作成に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/survey");
  return {};
}
