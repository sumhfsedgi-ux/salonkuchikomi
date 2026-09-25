"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";

const updateSalonSchema = z.object({
  name: z.string().trim().min(1, "店舗名を入力してください").max(100).optional(),
  description: z.string().trim().max(500).optional(),
  // Normalized to null on empty: unlike description,
  // salons.business_type has a check constraint that rejects ''.
  business_type: z
    .string()
    .trim()
    .max(100, "業種は100文字以内で入力してください")
    .optional()
    .transform((v) => (v ? v : null)),
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
  for (const key of ["name", "description", "business_type"] as const) {
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
    console.error("updateSalonAction failed", error);
    return { error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/settings");
  return { success: true };
}
