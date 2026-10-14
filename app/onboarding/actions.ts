"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { generateRandomSlug } from "@/lib/generateSlug";
import { getAccountState } from "@/lib/onboarding/accountState";
import { DB_FIELD_TO_FORM, parseSalonProfile } from "@/lib/onboarding/salonProfile";

// お客様自身の店舗の登録と、登録内容(店舗名・担当者・業種・連絡先)の修正。
// 所有者は、送られてきた値ではなく、このリクエストのセッション(auth.uid())で決まる(DB の create_own_salon)。
// 新しい店舗は必ず「利用開始待ち」・口コミプランで作る(区分・プラン・機能・管理者の権限は、お客様が指定できない)。

export type ProfileActionResult = { ok: true } | { ok: false; error?: string; fieldErrors?: Record<string, string> };

const SLUG_ATTEMPTS = 5;

export async function registerOwnSalonAction(input: Record<string, unknown>): Promise<ProfileActionResult> {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) return { ok: false, error: "ログインが必要です。ログインし直してください。" };
  const account = await getAccountState(supabase);
  if (!account?.sessionTrusted) return { ok: false, error: "本人確認が済んでいません。メールのリンクから手続きを続けてください。" };
  if (account.isOperator) return { ok: false, error: "運営管理のアカウントでは店舗を登録できません。" };

  const parsed = parseSalonProfile(input ?? {}, user.email ?? null);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
  const p = parsed.value;

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const { data, error } = await supabase.rpc("create_own_salon", {
      p_name: p.name,
      p_contact_name: p.contactName,
      p_business_type: p.businessType,
      p_contact_email: p.contactEmail,
      p_contact_phone: p.contactPhone,
      p_slug: generateRandomSlug(),
    });
    if (error) return { ok: false, error: "店舗の登録に失敗しました。時間をおいて、もう一度お試しください。" };
    const result = (data as { result?: string } | null)?.result ?? "";
    if (result === "slug_taken") continue;
    if (result === "created" || result === "already_exists") {
      // already_exists: 連打・別のタブ・運営の登録が先に済んでいた。新しい店舗は作らず、登録済みの店舗へ進む。
      revalidatePath("/dashboard");
      revalidatePath("/onboarding/status");
      return { ok: true };
    }
    if (result.startsWith("invalid:")) {
      const field = DB_FIELD_TO_FORM[result.slice("invalid:".length)] ?? "form";
      return { ok: false, fieldErrors: { [field]: "入力内容をご確認ください。" } };
    }
    if (result === "operator") return { ok: false, error: "運営管理のアカウントでは店舗を登録できません。" };
    if (result === "untrusted_session" || result === "email_unconfirmed") {
      return { ok: false, error: "本人確認が済んでいません。メールのリンクから手続きを続けてください。" };
    }
    return { ok: false, error: "店舗の登録に失敗しました。時間をおいて、もう一度お試しください。" };
  }
  return { ok: false, error: "店舗の登録に失敗しました。時間をおいて、もう一度お試しください。" };
}

/** 登録内容の修正(利用開始待ちでも行える。区分・プランなどは変えられない: DB の RLS と 0025 の制限)。 */
export async function updateRegistrationAction(input: Record<string, unknown>): Promise<ProfileActionResult> {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) return { ok: false, error: "ログインが必要です。ログインし直してください。" };
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "店舗の情報が見つかりません。ログインし直してください。" };

  const parsed = parseSalonProfile(input ?? {}, user.email ?? null);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
  const p = parsed.value;
  const { data, error } = await supabase
    .from("salons")
    .update({
      name: p.name,
      contact_name: p.contactName,
      business_type: p.businessType,
      contact_email: p.contactEmail,
      contact_phone: p.contactPhone,
      updated_at: new Date().toISOString(),
    })
    .eq("id", salon.id)
    .select("id");
  if (error || !data || data.length === 0) return { ok: false, error: "保存できませんでした。時間をおいて、もう一度お試しください。" };
  revalidatePath("/onboarding/status");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/settings");
  return { ok: true };
}
