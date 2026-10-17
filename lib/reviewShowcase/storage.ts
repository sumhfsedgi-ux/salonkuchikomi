// 口コミ作成中の表示の写真の置き場所(0033 の Storage バケット review-showcase。公開読み取り)。
// パスは「<salon_id>/<uuid>.<拡張子>」(DB の check と同じ形)。写真を変えるたびに新しい uuid にするので、
// 公開URLは変わり、古い写真がキャッシュから出ることはない。
import type { ShowcaseImageType } from "@/lib/reviewShowcase/settings";

export const SHOWCASE_BUCKET = "review-showcase";

const EXTENSIONS: Record<ShowcaseImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const PATH_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export function buildShowcaseImagePath(salonId: string, objectId: string, type: ShowcaseImageType): string {
  return `${salonId}/${objectId}.${EXTENSIONS[type]}`;
}

/** その店舗の写真のパスとして正しい形か(他店舗のパスや、形の違う値は使わない)。 */
export function isShowcaseImagePathOf(salonId: string, path: string): boolean {
  return PATH_PATTERN.test(path) && path.startsWith(`${salonId}/`);
}

/** 公開URL(Supabase Storage の public のバケット)。Supabase の URL が無いときは null。 */
export function showcaseImageUrl(path: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  if (!supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${SHOWCASE_BUCKET}/${path}`;
}
