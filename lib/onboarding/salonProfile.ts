import { z } from "zod";

// 店舗の登録内容(サロン名・担当者名・業種・連絡用メール・電話番号)の確認。お客様の登録・修正と、運営の下書き・本登録で共通。
// 誤りは項目ごとに返す(画面で、その欄の近くに出す)。DB の check 制約(0025)と同じ範囲にそろえる。

export const PROFILE_FIELDS = ["name", "contactName", "businessType", "contactEmail", "contactPhone"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^[0-9+() -]+$/;

/** 全角の数字・記号を半角にそろえる(電話番号・メールアドレス)。 */
export function toHalfWidth(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[ー−‐―]/g, "-")
    .replace(/　/g, " ");
}

export function normalizeEmail(value: string): string {
  return toHalfWidth(value).trim().toLowerCase();
}

export function normalizePhone(value: string): string {
  return toHalfWidth(value).trim().replace(/\s+/g, " ");
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .transform((v) => (v ? v : null));

export const salonProfileSchema = z
  .object({
    name: z.string().trim().min(1, "サロン名を入力してください。").max(100, "サロン名は100文字以内で入力してください。"),
    contactName: z.string().trim().min(1, "担当者名を入力してください。").max(100, "担当者名は100文字以内で入力してください。"),
    businessType: optionalText(100, "業種は100文字以内で入力してください。"),
    /** "same" = ログイン用のメールアドレスと同じ(連絡用メールは保存しない)。 */
    contactEmailMode: z.enum(["same", "other"]),
    contactEmail: z.string().transform(normalizeEmail),
    contactPhone: z.string().transform(normalizePhone),
  })
  .superRefine((v, ctx) => {
    if (v.contactEmailMode === "other") {
      if (!v.contactEmail) ctx.addIssue({ code: "custom", path: ["contactEmail"], message: "連絡用のメールアドレスを入力してください。" });
      else if (!isValidEmail(v.contactEmail)) ctx.addIssue({ code: "custom", path: ["contactEmail"], message: "メールアドレスの形式で入力してください。" });
    }
    if (v.contactPhone && (v.contactPhone.length > 30 || !PHONE.test(v.contactPhone))) {
      ctx.addIssue({ code: "custom", path: ["contactPhone"], message: "電話番号は数字とハイフンで入力してください(30文字以内)。" });
    }
  });

export interface SalonProfile {
  name: string;
  contactName: string;
  businessType: string | null;
  /** null = ログイン用と同じ */
  contactEmail: string | null;
  contactPhone: string | null;
}

export type ProfileParseResult = { ok: true; value: SalonProfile } | { ok: false; fieldErrors: FieldErrors<ProfileField> };

/** フォームの値(文字列)を確かめる。ログイン用と同じアドレスを「別のアドレス」に書いたときは、同じとして扱う。 */
export function parseSalonProfile(input: Record<string, unknown>, loginEmail: string | null): ProfileParseResult {
  const raw = {
    name: String(input.name ?? ""),
    contactName: String(input.contactName ?? ""),
    businessType: String(input.businessType ?? ""),
    contactEmailMode: input.contactEmailMode === "other" ? "other" : "same",
    contactEmail: String(input.contactEmail ?? ""),
    contactPhone: String(input.contactPhone ?? ""),
  };
  const parsed = salonProfileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, fieldErrors: toFieldErrors(parsed.error.issues) };
  const v = parsed.data;
  const contactEmail = v.contactEmailMode === "other" && v.contactEmail && v.contactEmail !== (loginEmail ?? "").toLowerCase() ? v.contactEmail : null;
  return {
    ok: true,
    value: { name: v.name, contactName: v.contactName, businessType: v.businessType, contactEmail, contactPhone: v.contactPhone || null },
  };
}

export function toFieldErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** DB の関数が返す invalid:<列名> を、画面の項目に直す。 */
export const DB_FIELD_TO_FORM: Record<string, string> = {
  name: "name",
  contact_name: "contactName",
  business_type: "businessType",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
  login_email: "loginEmail",
  plan: "plan",
  service_status: "serviceStatus",
  feature_overrides: "features",
};
