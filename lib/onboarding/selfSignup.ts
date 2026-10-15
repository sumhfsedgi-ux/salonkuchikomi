import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSelfSignupEnabled } from "@/lib/onboarding/authEmailPolicy";

// お客様が自分で店舗を登録できるか(新規登録の受付)。アプリの設定(SELF_SIGNUP_ENABLED)と、DB の受付の設定
// (self_signup_settings.open。0026)の両方が開いているときだけ受け付ける。読めなければ閉じているとして扱う。
// 閉じていても、運営の登録・招待、招待されたお客様の手続き、ログイン、パスワード再設定は止めない。
// DB の create_own_salon も受付の設定を確かめる(REST から直接呼ばれても作らない)。

export const SHOP_REGISTRATION_CLOSED_TEXT =
  "現在、新規の店舗登録は受け付けていません。ご利用を希望される場合は、運営にお問い合わせください。";

export async function isShopRegistrationOpen(admin: SupabaseClient): Promise<boolean> {
  if (!isSelfSignupEnabled()) return false;
  const { data, error } = await admin.from("self_signup_settings").select("open").eq("id", 1).maybeSingle();
  if (error) return false;
  return (data as { open?: boolean } | null)?.open === true;
}
