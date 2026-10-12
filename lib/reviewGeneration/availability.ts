import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * お客様用ページ・口コミ文章の生成 API で、その店舗の口コミを今使えるか(0024 の salon_public.reviews_available。
 * 管理画面・サロンの画面と同じ DB の判定)。運営が口コミの利用を止めている店舗は false。
 * 店舗が無い・判定を読めない(列が無いなど)ときも false(使える側に倒さない)。DB のエラーは投げる。
 */
export async function loadReviewsAvailable(supabase: SupabaseClient, salonId: string): Promise<boolean> {
  const { data, error } = await supabase.from("salon_public").select("reviews_available").eq("id", salonId).maybeSingle();
  if (error) throw error;
  return (data as { reviews_available?: boolean } | null)?.reviews_available === true;
}
