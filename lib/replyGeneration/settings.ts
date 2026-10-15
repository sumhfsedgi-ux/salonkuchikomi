import { z } from "zod";

// AI返信の設定(docs/plans/google-reviews-inbox-plan.md §9-4)。画面(クライアント)と
// サーバーの両方から使うので、ここには純粋な定義だけを置く(DB・環境変数に触れない)。
// 保存先は 0013 の review_reply_settings。行が無い・テーブルが無いときは既定値を使う。

export const REPLY_TONES = ["polite", "soft", "friendly"] as const;
export const REPLY_LENGTHS = ["short", "normal", "long"] as const;
export const REVISIT_LINES = ["natural", "none"] as const;

export type ReplyTone = (typeof REPLY_TONES)[number];
export type ReplyLength = (typeof REPLY_LENGTHS)[number];
export type RevisitLine = (typeof REVISIT_LINES)[number];

export interface ReplySettings {
  tone: ReplyTone;
  length: ReplyLength;
  includeStoreName: boolean;
  revisitLine: RevisitLine;
  /** 結びの署名(例「スタッフ一同」)。空なら付けない。 */
  signature: string;
  /** ★1〜2のときだけ末尾に添える連絡先の案内。空なら付けない。 */
  contactNote: string;
  /** 店舗からの追加の希望。安全のルールより優先しない参考情報として渡す。 */
  extraInstructions: string;
}

export const REPLY_TEXT_LIMITS = {
  signature: 30,
  contactNote: 80,
  extraInstructions: 200,
} as const;

export const DEFAULT_REPLY_SETTINGS: ReplySettings = {
  tone: "soft",
  length: "normal",
  includeStoreName: false,
  revisitLine: "natural",
  signature: "",
  contactNote: "",
  extraInstructions: "",
};

export const REPLY_TONE_OPTIONS: { value: ReplyTone; label: string }[] = [
  { value: "polite", label: "丁寧" },
  { value: "soft", label: "やわらかい" },
  { value: "friendly", label: "親しみやすい" },
];

export const REPLY_LENGTH_OPTIONS: { value: ReplyLength; label: string }[] = [
  { value: "short", label: "短め" },
  { value: "normal", label: "普通" },
  { value: "long", label: "丁寧に詳しく" },
];

export const STORE_NAME_OPTIONS: { value: "on" | "off"; label: string }[] = [
  { value: "on", label: "入れる" },
  { value: "off", label: "入れない" },
];

export const REVISIT_LINE_OPTIONS: { value: RevisitLine; label: string }[] = [
  { value: "natural", label: "自然な場合だけ" },
  { value: "none", label: "入れない" },
];

/** 返信の長さの目安(文字数。改行・空白を含まない)。 */
export const REPLY_LENGTH_TARGETS: Record<ReplyLength, { min: number; max: number }> = {
  short: { min: 40, max: 80 },
  normal: { min: 80, max: 160 },
  long: { min: 160, max: 300 },
};

// 改行は1つにまとめ、前後の空白を除く(1行の設定項目に改行を入れさせない)。
const singleLine = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\r\n]+/g, " ").trim())
    .pipe(z.string().max(max, `${max}文字以内で入力してください。`));

export const replySettingsSchema = z.object({
  tone: z.enum(REPLY_TONES),
  length: z.enum(REPLY_LENGTHS),
  includeStoreName: z.boolean(),
  revisitLine: z.enum(REVISIT_LINES),
  signature: singleLine(REPLY_TEXT_LIMITS.signature),
  contactNote: singleLine(REPLY_TEXT_LIMITS.contactNote),
  extraInstructions: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().max(REPLY_TEXT_LIMITS.extraInstructions, `${REPLY_TEXT_LIMITS.extraInstructions}文字以内で入力してください。`)),
});

/** DB の行(snake_case)を設定に変換する。値が不正なら既定値に戻す。 */
export function replySettingsFromRow(row: Record<string, unknown> | null | undefined): ReplySettings {
  if (!row) return { ...DEFAULT_REPLY_SETTINGS };
  const parsed = replySettingsSchema.safeParse({
    tone: row.tone,
    length: row.length,
    includeStoreName: row.include_store_name,
    revisitLine: row.revisit_line,
    signature: row.signature ?? "",
    contactNote: row.contact_note ?? "",
    extraInstructions: row.extra_instructions ?? "",
  });
  return parsed.success ? parsed.data : { ...DEFAULT_REPLY_SETTINGS };
}

export function replySettingsToRow(salonId: string, settings: ReplySettings) {
  return {
    salon_id: salonId,
    tone: settings.tone,
    length: settings.length,
    include_store_name: settings.includeStoreName,
    revisit_line: settings.revisitLine,
    signature: settings.signature,
    contact_note: settings.contactNote,
    extra_instructions: settings.extraInstructions,
    updated_at: new Date().toISOString(),
  };
}

export function sameReplySettings(a: ReplySettings, b: ReplySettings): boolean {
  return (
    a.tone === b.tone &&
    a.length === b.length &&
    a.includeStoreName === b.includeStoreName &&
    a.revisitLine === b.revisitLine &&
    a.signature === b.signature &&
    a.contactNote === b.contactNote &&
    a.extraInstructions === b.extraInstructions
  );
}
