import "server-only";
import { cache } from "react";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isFeatureKey } from "@/lib/features/registry";
import { toSalonEntitlements, type EntitlementRow, type SalonEntitlements } from "@/lib/features/entitlements";

// 店舗の全機能の利用権限を、DB の salon_feature_access_all(通知処理の DB 関数と同じ判定)から読む。
// リクエストごとに1回だけ読む(同じ店舗の画面・メニュー・Server Action の判定で共有する)。
// service role で読む(この関数はブラウザのロールには実行権限が無い)。店舗の id はサーバーで解決したものだけを渡す。
// 読めなかったときは例外にする(利用できる側に倒さない)。
export const loadSalonEntitlements = cache(async (salonId: string): Promise<SalonEntitlements> => {
  const { data, error } = await getSupabaseAdmin().rpc("salon_feature_access_all", { p_salon_id: salonId });
  if (error) throw new Error("機能の利用権限の取得に失敗しました。");
  return toSalonEntitlements((data ?? []) as EntitlementRow[], isFeatureKey);
});
