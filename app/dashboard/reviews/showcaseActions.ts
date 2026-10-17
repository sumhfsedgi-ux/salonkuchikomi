"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolveFeatureSalon } from "@/lib/access/featureAccess";
import {
  catchCopyError,
  enableError,
  normalizeCatchCopy,
  type ShowcaseSettings,
} from "@/lib/reviewShowcase/settings";
import { checkShowcaseImage } from "@/lib/reviewShowcase/image";
import { buildShowcaseImagePath } from "@/lib/reviewShowcase/storage";
import {
  loadShowcase,
  removeShowcaseImages,
  saveShowcaseRow,
  showcaseSettingsFromRow,
  uploadShowcaseImage,
} from "@/lib/reviewShowcase/repo";

export type SaveShowcaseResult = { ok: true; settings: ShowcaseSettings } | { ok: false; error: string };

const SAVE_FAILED = "保存できませんでした。もう一度お試しください。";
const UNAVAILABLE = "口コミ作成中の表示の保存は準備中です。";

// 口コミ作成中の表示(写真・キャッチコピー・有効/無効)を保存する。
// 店舗はログイン中のセッションから解決した店舗だけ(フォームの salon_id などは受け取らない)。
// 写真を変えるときは、新しい写真を置く → 行を更新する → 古い写真を消す、の順にする
// (行の更新に失敗したら新しい写真を消す。古い写真の削除に失敗しても、保存は成功のまま)。
//
// フォームの項目: enabled("1" / それ以外)・catch_copy・image(File。変えるときだけ)・remove_image("1" で削除)
export async function saveReviewShowcaseAction(formData: FormData): Promise<SaveShowcaseResult> {
  const supabase = await createClient();
  const access = await resolveFeatureSalon(supabase, "reviews");
  if (!access.ok) return { ok: false, error: access.error };
  const salonId = access.salon.id;

  const catchCopy = normalizeCatchCopy(String(formData.get("catch_copy") ?? ""));
  const copyProblem = catchCopyError(catchCopy);
  if (copyProblem) return { ok: false, error: copyProblem };
  const enabled = formData.get("enabled") === "1";
  const removeImage = formData.get("remove_image") === "1";
  const image = formData.get("image");
  const newFile = image instanceof File && image.size > 0 ? image : null;

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch {
    return { ok: false, error: UNAVAILABLE };
  }

  const current = await loadShowcase(admin, salonId);
  if (!current.storageAvailable) return { ok: false, error: UNAVAILABLE };
  const oldPath = current.row?.imagePath ?? null;

  // 写真を確かめてから(置く前に)、有効にできるかを確かめる。
  let upload: { bytes: Uint8Array; type: Parameters<typeof uploadShowcaseImage>[3] } | null = null;
  if (newFile) {
    const bytes = new Uint8Array(await newFile.arrayBuffer());
    const checked = checkShowcaseImage(bytes);
    if (!checked.ok) return { ok: false, error: checked.error };
    upload = { bytes, type: checked.type };
  }
  const hasImage = upload !== null || (!removeImage && oldPath !== null);
  if (enabled) {
    const problem = enableError({ hasImage, catchCopy });
    if (problem) return { ok: false, error: problem };
  }

  let nextPath = removeImage ? null : oldPath;
  if (upload) {
    nextPath = buildShowcaseImagePath(salonId, randomUUID(), upload.type);
    if (!(await uploadShowcaseImage(admin, nextPath, upload.bytes, upload.type))) {
      return { ok: false, error: "写真を保存できませんでした。もう一度お試しください。" };
    }
  }

  const row = { enabled, catchCopy, imagePath: nextPath };
  const outcome = await saveShowcaseRow(admin, salonId, row);
  if (outcome !== "saved") {
    if (upload && nextPath) await removeShowcaseImages(admin, [nextPath]);
    return { ok: false, error: outcome === "unavailable" ? UNAVAILABLE : SAVE_FAILED };
  }
  if (oldPath && oldPath !== nextPath) await removeShowcaseImages(admin, [oldPath]);

  revalidatePath("/dashboard/reviews");
  revalidatePath("/review/[slug]", "page");
  return { ok: true, settings: showcaseSettingsFromRow(row) };
}
