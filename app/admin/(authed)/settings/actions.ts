"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";

const updateSalonSchema = z.object({
  name: z.string().trim().min(1, "店舗名を入力してください").max(100).optional(),
  slug: z
    .string()
    .trim()
    .min(1, "ページURLを入力してください")
    .max(60)
    .regex(/^[a-z0-9-]+$/, "ページURLは半角英数字とハイフンのみ使用できます")
    .optional(),
  google_review_url: z.string().trim().max(500).optional(),
  description: z.string().trim().max(500).optional(),
});

// Only ever resolves "my own salon" via the authenticated session — never
// trusts a salon id supplied by the caller.
export async function updateSalonAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };

  const raw: Record<string, string> = {};
  for (const key of ["name", "slug", "google_review_url", "description"] as const) {
    const value = formData.get(key);
    if (value !== null) raw[key] = String(value);
  }

  const parsed = updateSalonSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  }
  if (Object.keys(parsed.data).length === 0) {
    return { error: "更新する内容がありません。" };
  }

  const { error } = await supabase
    .from("salons")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", salon.id);

  if (error) {
    if (error.code === "23505") {
      return { error: "このページURLはすでに使用されています。別のURLをお試しください。" };
    }
    console.error("updateSalonAction failed", error);
    return { error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/settings");
  return { success: true };
}
