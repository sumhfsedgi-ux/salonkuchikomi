"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { salonSettingsSchema, type SalonSettingsInput } from "@/lib/blog/validation";
import { upsertSalonSettings } from "@/lib/blog/queries";

export interface SaveSalonSettingsResult {
  ok: boolean;
  error?: string;
}

export async function saveSalonSettingsAction(
  input: SalonSettingsInput
): Promise<SaveSalonSettingsResult> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "ログインが必要です。" };

  const parsed = salonSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return { ok: false, error: firstIssue?.message ?? "入力内容を確認してください。" };
  }

  try {
    await upsertSalonSettings(salon.id, {
      ...parsed.data,
      avoidExpressions: parsed.data.avoidExpressions?.trim() || null,
    });
  } catch (err) {
    console.error("saveSalonSettingsAction failed", err);
    return { ok: false, error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard/blog/settings");
  return { ok: true };
}
