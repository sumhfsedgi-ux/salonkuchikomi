"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import {
  hotpepperImportInputSchema,
  referencePostToggleSchema,
} from "@/lib/blog/validation";
import {
  validateHotPepperBlogUrl,
  importHotPepperBlogPosts,
  HotPepperFetchError,
} from "@/lib/blog/hotpepper/scraper";
import {
  listReferencePostSourceUrls,
  bulkInsertReferencePosts,
  updateHotPepperBlogUrl,
  setReferencePostUseForStyle,
  listReferencePosts,
  upsertStyleProfile,
  ensureSalonSettingsRow,
} from "@/lib/blog/queries";
import { callOpenAIJson, OpenAICallError } from "@/lib/blog/openai";
import {
  buildStyleProfileSystemPrompt,
  buildStyleProfileUserPrompt,
  STYLE_PROFILE_SCHEMA,
} from "@/lib/blog/prompts";
import {
  MIN_STYLE_PROFILE_POSTS,
  MAX_STYLE_PROFILE_SOURCE_POSTS,
} from "@/lib/blog/config/hotpepper";
import type { SalonStyleProfileData } from "@/lib/blog/types";

export interface HotpepperActionResult {
  ok: boolean;
  error?: string;
}

export interface ImportHotPepperBlogResult extends HotpepperActionResult {
  imported?: number;
  skippedExisting?: number;
  failed?: number;
  totalFoundOnSite?: number | null;
}

function hotPepperErrorMessage(kind: HotPepperFetchError["kind"]): string {
  switch (kind) {
    case "robots_disallowed":
      return "このページは robots.txt により取得が禁止されています。";
    case "timeout":
      return "取得がタイムアウトしました。時間をおいてもう一度お試しください。";
    case "network_error":
      return "ネットワークエラーが発生しました。時間をおいてもう一度お試しください。";
    case "http_error":
      return "ページの取得に失敗しました。URLが正しいか確認してください。";
    case "parse_error":
      return "ページの構造を認識できませんでした。サイトの仕様が変更された可能性があります。";
  }
}

async function requireSalonId(): Promise<{ salonId: string } | { error: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "ログインが必要です。" };
  return { salonId: salon.id };
}

export async function importHotPepperBlogAction(
  rawUrl: string
): Promise<ImportHotPepperBlogResult> {
  const auth = await requireSalonId();
  if ("error" in auth) return { ok: false, error: auth.error };
  const { salonId } = auth;

  const parsed = hotpepperImportInputSchema.safeParse({ url: rawUrl });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "URLを入力してください。" };
  }

  const validation = validateHotPepperBlogUrl(parsed.data.url);
  if (!validation.ok || !validation.normalizedUrl) {
    return { ok: false, error: validation.reason ?? "URLの形式が正しくありません。" };
  }

  try {
    await ensureSalonSettingsRow(salonId);
    const existingSourceUrls = await listReferencePostSourceUrls(salonId);
    const result = await importHotPepperBlogPosts(validation.normalizedUrl, {
      existingSourceUrls,
    });

    if (result.newPosts.length > 0) {
      await bulkInsertReferencePosts(salonId, result.newPosts);
    }
    await updateHotPepperBlogUrl(salonId, validation.normalizedUrl);

    revalidatePath("/dashboard/blog/settings/style-profile");
    revalidatePath("/dashboard/blog/settings");

    return {
      ok: true,
      imported: result.newPosts.length,
      skippedExisting: result.skippedExisting,
      failed: result.failed,
      totalFoundOnSite: result.totalFoundOnSite,
    };
  } catch (err) {
    if (err instanceof HotPepperFetchError) {
      return { ok: false, error: hotPepperErrorMessage(err.kind) };
    }
    console.error("importHotPepperBlogAction failed", err);
    return { ok: false, error: "取り込みに失敗しました。もう一度お試しください。" };
  }
}

export async function toggleReferencePostUseForStyleAction(
  id: string,
  useForStyle: boolean
): Promise<HotpepperActionResult> {
  const auth = await requireSalonId();
  if ("error" in auth) return { ok: false, error: auth.error };
  const { salonId } = auth;

  const parsed = referencePostToggleSchema.safeParse({ id, useForStyle });
  if (!parsed.success) {
    return { ok: false, error: "リクエストが正しくありません。" };
  }

  try {
    await setReferencePostUseForStyle(salonId, parsed.data.id, parsed.data.useForStyle);
  } catch (err) {
    console.error("toggleReferencePostUseForStyleAction failed", err);
    return { ok: false, error: "更新に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard/blog/settings/style-profile");
  return { ok: true };
}

export async function generateStyleProfileAction(): Promise<HotpepperActionResult> {
  const auth = await requireSalonId();
  if ("error" in auth) return { ok: false, error: auth.error };
  const { salonId } = auth;

  try {
    const selected = await listReferencePosts(salonId, { onlySelected: true });
    if (selected.length < MIN_STYLE_PROFILE_POSTS) {
      return {
        ok: false,
        error: `文体プロファイルの作成には記事を${MIN_STYLE_PROFILE_POSTS}件以上選択してください。`,
      };
    }

    // 選択件数が多すぎる場合は、投稿日が新しい順（listReferencePostsの並び順）に
    // 先頭N件のみ使用する（ランダムではなく決定的に絞り込み、再現性を優先する）。
    const sourcePosts = selected.slice(0, MAX_STYLE_PROFILE_SOURCE_POSTS);

    const profile = await callOpenAIJson<SalonStyleProfileData>({
      systemPrompt: buildStyleProfileSystemPrompt(),
      userPrompt: buildStyleProfileUserPrompt({ posts: sourcePosts }),
      schema: STYLE_PROFILE_SCHEMA,
      temperature: 0.3,
      // 見出し・箇条書き分析に加え、絵文字・顔文字・装飾記号・句読点分析も追加し
      // スキーマがさらに拡大したため引き上げ。
      maxTokens: 3000,
      timeoutMs: 45_000,
    });

    await upsertStyleProfile(salonId, {
      profile,
      sourcePostIds: sourcePosts.map((p) => p.id),
    });
  } catch (err) {
    if (err instanceof OpenAICallError) {
      return { ok: false, error: "文体プロファイルの生成に失敗しました。もう一度お試しください。" };
    }
    console.error("generateStyleProfileAction failed", err);
    return { ok: false, error: "文体プロファイルの生成に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/dashboard/blog/settings/style-profile");
  return { ok: true };
}
