import { z } from "zod";
import { CUSTOM_LENGTH_BOUNDS } from "@/lib/blog/config/blogRules";
import {
  TONE_OPTIONS,
  EMOJI_LEVELS,
  TAG_LIST_LIMITS,
  SHORT_TEXT_LIMITS,
} from "@/lib/blog/config/salon";

// (blog-appの lib/validation.ts を無変更で移植、import pathのみ更新)

const themeInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("omakase") }),
  z.object({ mode: z.literal("specified"), text: z.string().trim().min(1).max(60) }),
]);

const lengthInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("short") }),
  z.object({ type: z.literal("standard") }),
  z.object({ type: z.literal("long") }),
  z.object({
    type: z.literal("custom"),
    target: z.number().int().min(CUSTOM_LENGTH_BOUNDS.min).max(CUSTOM_LENGTH_BOUNDS.max),
  }),
]);

const currentDraftFields = {
  postId: z.string().uuid(),
  currentTitle: z.string().trim().min(1).max(200),
  currentBody: z.string().trim().min(1).max(8000),
};

// 注意: このスキーマは意図的に salonId を含まない。生成対象のサロンは
// 常にサーバー側で認証済みセッションから解決する（app/api/blog/generate/route.ts
// 参照）。クライアントからsalonIdを受け取って信用することは絶対にしない。
export const generateRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create"), theme: themeInputSchema, length: lengthInputSchema }),
  z.object({
    mode: z.literal("regenerate"),
    postId: z.string().uuid(),
    theme: themeInputSchema,
    length: lengthInputSchema,
  }),
  z.object({ mode: z.literal("shorten"), ...currentDraftFields }),
  z.object({ mode: z.literal("soften"), ...currentDraftFields }),
  z.object({ mode: z.literal("detail"), ...currentDraftFields }),
]);

export type GenerateRequestInput = z.infer<typeof generateRequestSchema>;

const tagListSchema = z
  .array(z.string().trim().min(1).max(TAG_LIST_LIMITS.maxItemLength))
  .max(TAG_LIST_LIMITS.maxItems);

export const salonSettingsSchema = z.object({
  mainMenu: tagListSchema,
  specialties: tagListSchema,
  targetCustomers: tagListSchema,
  commonConcerns: tagListSchema,
  salonTraits: z.string().trim().max(SHORT_TEXT_LIMITS.salonTraits),
  tone: z.enum(TONE_OPTIONS),
  emojiLevel: z.enum(EMOJI_LEVELS),
  avoidExpressions: z.string().trim().max(SHORT_TEXT_LIMITS.avoidExpressions).nullable(),
});

export type SalonSettingsInput = z.infer<typeof salonSettingsSchema>;

// ---------------------------------------------------------------------------
// 文体参照機能（Style Profile / Hot Pepper Beauty取り込み）
// ---------------------------------------------------------------------------

// URLのホスト名・パスの妥当性そのものは lib/blog/hotpepper/scraper.ts の
// validateHotPepperBlogUrl() に一本化する（ビジネスルールの単一情報源を保つため）。
// ここでは素朴な文字数上限のみを見る。
export const hotpepperImportInputSchema = z.object({
  url: z.string().trim().min(1, "URLを入力してください").max(300),
});
export type HotpepperImportInput = z.infer<typeof hotpepperImportInputSchema>;

export const referencePostToggleSchema = z.object({
  id: z.string().uuid(),
  useForStyle: z.boolean(),
});
export type ReferencePostToggleInput = z.infer<typeof referencePostToggleSchema>;
