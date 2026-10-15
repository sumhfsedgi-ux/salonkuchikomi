import { z } from "zod";
import { isFeatureKey, type FeatureKey } from "@/lib/features/registry";
import { isValidEmail, normalizeEmail, normalizePhone, toFieldErrors, type FieldErrors } from "@/lib/onboarding/salonProfile";
import type { RegistrationKind } from "@/lib/onboarding/serviceStatus";
import type { SalonPlan } from "@/lib/access/plan";

// 運営の「サロンを追加」の入力(DBに触れない)。下書きはサロン名だけで保存できる。本登録には、担当者名・ログイン用の
// メールアドレス・登録種別がそろっていることを求める(DB の admin_register_salon でも確かめる)。
// 登録種別は「通常登録(pending)」と「テスト用」だけ(新しい店舗は無料提供にできない。0026)。
// プラン: 通常登録では「案内予定のプラン」(任意。契約ではない)、テスト用では「契約プラン」(必須)。
// プランが未定のときは、機能ごとの利用許可は設定できない(保存のときに外す。DB も、プランの無い利用許可を登録しない)。

export interface DraftFormValues {
  name: string;
  contactName: string;
  loginEmail: string;
  businessType: string;
  contactEmailMode: "same" | "other";
  contactEmail: string;
  contactPhone: string;
  plan: "" | SalonPlan;
  serviceStatus: "" | RegistrationKind;
  /** 個別設定(書かない機能はプランの標準)。 */
  featureOverrides: Partial<Record<FeatureKey, "allow" | "deny">>;
}

export const EMPTY_DRAFT: DraftFormValues = {
  name: "",
  contactName: "",
  loginEmail: "",
  businessType: "",
  contactEmailMode: "same",
  contactEmail: "",
  contactPhone: "",
  plan: "",
  // 新しい下書きは「通常登録」(pending)を初期選択にする。保存済みの下書きは、保存されている選択のまま開く
  serviceStatus: "pending",
  featureOverrides: {},
};

export const DRAFT_FIELD_ORDER = [
  "name",
  "contactName",
  "loginEmail",
  "businessType",
  "contactEmail",
  "contactPhone",
  "plan",
  "serviceStatus",
  "features",
] as const;
export type DraftField = (typeof DRAFT_FIELD_ORDER)[number];

const PHONE = /^[0-9+() -]+$/;

const schema = z
  .object({
    name: z.string().trim().min(1, "サロン名を入力してください。").max(100, "サロン名は100文字以内で入力してください。"),
    contactName: z.string().trim().max(100, "担当者名は100文字以内で入力してください。"),
    loginEmail: z.string().transform(normalizeEmail),
    businessType: z.string().trim().max(100, "業種は100文字以内で入力してください。"),
    contactEmailMode: z.enum(["same", "other"]),
    contactEmail: z.string().transform(normalizeEmail),
    contactPhone: z.string().transform(normalizePhone),
    plan: z.enum(["", "reviews", "salonpack"]),
    serviceStatus: z.enum(["", "pending", "test"], { message: "登録種別は「通常登録」か「テスト用」を選んでください。" }),
    featureOverrides: z.record(z.string(), z.enum(["allow", "deny"])),
  })
  .superRefine((v, ctx) => {
    if (v.loginEmail && !isValidEmail(v.loginEmail)) {
      ctx.addIssue({ code: "custom", path: ["loginEmail"], message: "メールアドレスの形式で入力してください。" });
    }
    if (v.contactEmailMode === "other") {
      if (!v.contactEmail) ctx.addIssue({ code: "custom", path: ["contactEmail"], message: "連絡用のメールアドレスを入力してください。" });
      else if (!isValidEmail(v.contactEmail)) ctx.addIssue({ code: "custom", path: ["contactEmail"], message: "メールアドレスの形式で入力してください。" });
    }
    if (v.contactPhone && (v.contactPhone.length > 30 || !PHONE.test(v.contactPhone))) {
      ctx.addIssue({ code: "custom", path: ["contactPhone"], message: "電話番号は数字とハイフンで入力してください(30文字以内)。" });
    }
    for (const key of Object.keys(v.featureOverrides)) {
      if (!isFeatureKey(key)) ctx.addIssue({ code: "custom", path: ["features"], message: "機能の指定が正しくありません。" });
    }
  });

/** DB(admin_save_salon_draft)に渡す形。 */
export interface DraftDbFields {
  name: string;
  contact_name: string | null;
  login_email: string | null;
  business_type: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  plan: SalonPlan | null;
  service_status: RegistrationKind | null;
  feature_overrides: Record<string, "allow" | "deny">;
}

export type DraftParseResult = { ok: true; fields: DraftDbFields } | { ok: false; fieldErrors: FieldErrors<DraftField> };

export function parseDraftForm(input: unknown): DraftParseResult {
  const raw = (input ?? {}) as Record<string, unknown>;
  const parsed = schema.safeParse({
    name: String(raw.name ?? ""),
    contactName: String(raw.contactName ?? ""),
    loginEmail: String(raw.loginEmail ?? ""),
    businessType: String(raw.businessType ?? ""),
    contactEmailMode: raw.contactEmailMode === "other" ? "other" : "same",
    contactEmail: String(raw.contactEmail ?? ""),
    contactPhone: String(raw.contactPhone ?? ""),
    plan: raw.plan ?? "",
    serviceStatus: raw.serviceStatus ?? "",
    featureOverrides: raw.featureOverrides ?? {},
  });
  if (!parsed.success) return { ok: false, fieldErrors: toFieldErrors(parsed.error.issues) as FieldErrors<DraftField> };
  const v = parsed.data;
  const contactEmail = v.contactEmailMode === "other" && v.contactEmail && v.contactEmail !== v.loginEmail ? v.contactEmail : null;
  return {
    ok: true,
    fields: {
      name: v.name,
      contact_name: v.contactName || null,
      login_email: v.loginEmail || null,
      business_type: v.businessType || null,
      contact_email: contactEmail,
      contact_phone: v.contactPhone || null,
      plan: v.plan || null,
      service_status: v.serviceStatus || null,
      feature_overrides: v.plan ? v.featureOverrides : {},
    },
  };
}

/** 本登録に足りない項目(画面で、その欄の近くに出す)。 */
export function missingForRegistration(f: Pick<DraftDbFields, "contact_name" | "login_email" | "plan" | "service_status">): FieldErrors<DraftField> {
  const errors: FieldErrors<DraftField> = {};
  if (!f.contact_name) errors.contactName = "本登録には、担当者名が必要です。";
  if (!f.login_email) errors.loginEmail = "本登録には、ログイン用のメールアドレスが必要です。";
  if (!f.service_status) errors.serviceStatus = "本登録には、登録種別の選択が必要です。";
  if (f.service_status === "test" && !f.plan) errors.plan = "テスト用の店舗の本登録には、契約プランの選択が必要です。";
  return errors;
}

/** DB の invalid:<列名> / incomplete:<列名> を、画面の項目に直す。 */
export function draftFieldOf(dbField: string): DraftField {
  const map: Record<string, DraftField> = {
    name: "name",
    contact_name: "contactName",
    login_email: "loginEmail",
    business_type: "businessType",
    contact_email: "contactEmail",
    contact_phone: "contactPhone",
    plan: "plan",
    service_status: "serviceStatus",
    feature_overrides: "features",
  };
  return map[dbField] ?? "name";
}
