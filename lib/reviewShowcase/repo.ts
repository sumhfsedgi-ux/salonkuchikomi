import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicShowcase, ShowcaseImageType, ShowcaseSettings } from "@/lib/reviewShowcase/settings";
import { DEFAULT_SHOWCASE_SETTINGS } from "@/lib/reviewShowcase/settings";
import { SHOWCASE_BUCKET, isShowcaseImagePathOf, showcaseImageUrl } from "@/lib/reviewShowcase/storage";

// 口コミ作成中の表示の読み書き(0033)。
//   ・管理画面の読み書き(review_generation_showcases・Storage)は service role で行う。salon_id は必ずサーバーで
//     確定した値(利用可否の判定を通った店舗)を渡すこと(lib/supabase/admin.ts の注意と同じ)。
//   ・お客様ページは公開用のビュー(review_showcase_public)を anon で読む。
// 0033 を適用する前(表・ビューが無い)でも画面が止まらないよう、読み込みは「未設定」に戻す。

export interface ShowcaseRow {
  enabled: boolean;
  catchCopy: string;
  imagePath: string | null;
}

export interface LoadedShowcase {
  row: ShowcaseRow | null;
  /** 保存できる状態か(0033 が適用済みで、読み込みにも成功した)。 */
  storageAvailable: boolean;
}

// 表が無いときの PostgREST / Postgres のエラーコード。
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

export async function loadShowcase(admin: SupabaseClient, salonId: string): Promise<LoadedShowcase> {
  try {
    const { data, error } = await admin
      .from("review_generation_showcases")
      .select("enabled, catch_copy, image_path")
      .eq("salon_id", salonId)
      .maybeSingle();
    if (error) {
      console.warn("review_generation_showcases load failed", { code: error.code });
      return { row: null, storageAvailable: false };
    }
    if (!data) return { row: null, storageAvailable: true };
    const imagePath = typeof data.image_path === "string" && isShowcaseImagePathOf(salonId, data.image_path) ? data.image_path : null;
    return {
      row: { enabled: data.enabled === true, catchCopy: String(data.catch_copy ?? ""), imagePath },
      storageAvailable: true,
    };
  } catch {
    console.warn("review_generation_showcases load failed");
    return { row: null, storageAvailable: false };
  }
}

export function showcaseSettingsFromRow(row: ShowcaseRow | null): ShowcaseSettings {
  if (!row) return { ...DEFAULT_SHOWCASE_SETTINGS };
  return {
    enabled: row.enabled,
    catchCopy: row.catchCopy,
    imageUrl: row.imagePath ? showcaseImageUrl(row.imagePath) : null,
  };
}

export type SaveShowcaseOutcome = "saved" | "unavailable" | "failed";

export async function saveShowcaseRow(admin: SupabaseClient, salonId: string, row: ShowcaseRow): Promise<SaveShowcaseOutcome> {
  try {
    const { error } = await admin.from("review_generation_showcases").upsert(
      {
        salon_id: salonId,
        enabled: row.enabled,
        catch_copy: row.catchCopy,
        image_path: row.imagePath,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "salon_id" },
    );
    if (!error) return "saved";
    console.warn("review_generation_showcases save failed", { code: error.code });
    return MISSING_TABLE_CODES.has(error.code ?? "") ? "unavailable" : "failed";
  } catch {
    console.warn("review_generation_showcases save failed");
    return "failed";
  }
}

export async function uploadShowcaseImage(
  admin: SupabaseClient,
  path: string,
  bytes: Uint8Array,
  type: ShowcaseImageType,
): Promise<boolean> {
  try {
    const { error } = await admin.storage
      .from(SHOWCASE_BUCKET)
      .upload(path, bytes, { contentType: type, cacheControl: "31536000", upsert: false });
    if (error) console.warn("review-showcase upload failed", { message: error.message });
    return !error;
  } catch {
    console.warn("review-showcase upload failed");
    return false;
  }
}

/** 写真を消す。失敗しても投げない(残った写真は、どの行からも参照されない)。 */
export async function removeShowcaseImages(admin: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { error } = await admin.storage.from(SHOWCASE_BUCKET).remove(paths);
    if (error) console.warn("review-showcase remove failed", { message: error.message });
  } catch {
    console.warn("review-showcase remove failed");
  }
}

/** お客様ページ用。有効で、写真とコピーがあり、口コミを使える店舗のときだけ返す(それ以外・失敗は null)。 */
export async function loadPublicShowcase(client: SupabaseClient, salonId: string): Promise<PublicShowcase | null> {
  try {
    const { data, error } = await client
      .from("review_showcase_public")
      .select("catch_copy, image_path")
      .eq("salon_id", salonId)
      .maybeSingle();
    if (error || !data) return null;
    const path = typeof data.image_path === "string" ? data.image_path : "";
    const catchCopy = typeof data.catch_copy === "string" ? data.catch_copy.trim() : "";
    if (!catchCopy || !isShowcaseImagePathOf(salonId, path)) return null;
    const imageUrl = showcaseImageUrl(path);
    return imageUrl ? { imageUrl, catchCopy } : null;
  } catch {
    return null;
  }
}
