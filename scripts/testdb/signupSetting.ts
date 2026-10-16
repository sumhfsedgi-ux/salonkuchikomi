// 共有のテスト用DBの「新規登録の受付」(self_signup_settings.open。0026)を、検証のあいだだけ変える。
// 変える前の値を記録し、検証の終わり・失敗のときに必ず元に戻す(開けたままにしない)。
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SignupSettingHandle {
  /** 変える前の値。 */
  previous: boolean;
  /** 元の値に戻す(何度呼んでも同じ)。 */
  restore: () => Promise<void>;
}

async function write(admin: SupabaseClient, open: boolean): Promise<void> {
  const { error } = await admin.from("self_signup_settings").update({ open, updated_at: new Date().toISOString() }).eq("id", 1);
  if (error) throw new Error(`新規登録の受付の設定を変えられません: ${error.code}`);
}

export async function readSignupOpen(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin.from("self_signup_settings").select("open").eq("id", 1).single();
  if (error || !data) throw new Error(`新規登録の受付の設定を読めません(0026 が未適用の可能性): ${error?.code}`);
  return (data as { open: boolean }).open;
}

export async function overrideSignupSetting(admin: SupabaseClient, open: boolean): Promise<SignupSettingHandle> {
  const previous = await readSignupOpen(admin);
  if (previous !== open) await write(admin, open);
  console.log(`[新規登録の受付] 変更前: ${previous ? "開" : "閉"} → 検証のあいだ: ${open ? "開" : "閉"}`);
  let restored = false;
  return {
    previous,
    restore: async () => {
      if (restored) return;
      restored = true;
      if ((await readSignupOpen(admin)) !== previous) await write(admin, previous);
      console.log(`[新規登録の受付] 元に戻しました: ${previous ? "開" : "閉"}`);
    },
  };
}
