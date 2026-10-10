"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { loadSetupContext } from "@/lib/features/setupContext";
import { isFeatureAvailable, isFeatureEntitled } from "@/lib/features/featureState";
import { FEATURE_REGISTRY, isFeatureKey } from "@/lib/features/registry";
import { saveFeatureSelection } from "@/lib/features/selection";

// 利用する機能の選択を保存する。契約上利用でき、提供中の機能だけを受け付ける。
// 契約(plan)の変更・データの削除・Google 連携の解除は行わない。

export async function updateFeatureSelectionAction(selectedKeys: string[]): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "店舗情報が見つかりません。" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "ログインが必要です。" };

  const ctx = await loadSetupContext(salon);
  const allowed = new Set(
    FEATURE_REGISTRY.filter((def) => isFeatureEntitled(salon.plan, def) && isFeatureAvailable(def, ctx)).map((def) => def.key)
  );
  const requested = selectedKeys.filter(isFeatureKey);
  if (requested.some((key) => !allowed.has(key))) {
    return { ok: false, error: "選べない機能が含まれています。" };
  }

  try {
    await saveFeatureSelection({ salonId: salon.id, userId: user.id, selected: requested });
  } catch {
    return { ok: false, error: "保存に失敗しました。もう一度お試しください。" };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true };
}
