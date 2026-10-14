import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * お客様用ページ・口コミ文章の生成 API で、その店舗の口コミを今使えるか(0024 の salon_public.reviews_available。
 * 管理画面・サロンの画面と同じ DB の判定)。運営が口コミの利用を止めている店舗は false。
 * 店舗が無いときは null。判定を読めない(列が無いなど)ときは false(使える側に倒さない)。DB のエラーは投げる。
 * 利用開始待ちの店舗(0025)も false。使えない店舗のアンケートは、お客様用ページの RLS でも読めない(0025)。
 */
export async function loadReviewsAvailable(supabase: SupabaseClient, salonId: string): Promise<boolean | null> {
  const { data, error } = await supabase.from("salon_public").select("reviews_available").eq("id", salonId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (data as { reviews_available?: boolean }).reviews_available === true;
}
