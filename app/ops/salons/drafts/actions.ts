"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOperator } from "@/lib/ops/operator";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { generateRandomSlug } from "@/lib/generateSlug";
import { draftFieldOf, missingForRegistration, parseDraftForm } from "@/lib/ops/draftForm";
import { getDraft } from "@/lib/ops/onboardingQueries";
import { lookupLoginAccount, prepareLoginAccount } from "@/lib/onboarding/accounts";
import { sendInvitationNotice, type InvitationSendResult } from "@/lib/onboarding/invitation";

// 運営の「サロンを追加」(下書き・内容の確認・本登録と案内の送信)。どれも先頭で requireOperator() を呼び(管理者でなければ 404)、
// 操作した人はサーバーで認証した ID だけを使う(ブラウザから受け取った値は使わない)。
// 下書きでは、アカウントを作らず、メールも送らず、サービスも有効にしない(salons に入れない)。

export type DraftActionResult =
  | { ok: true; draftId: string; version: number }
  | { ok: false; error?: string; fieldErrors?: Record<string, string>; conflict?: boolean; registeredSalonId?: string };

const CONFLICT_ERROR = "ほかの操作で内容が変わっています。画面を再読み込みして、最新の内容を確認してから操作してください。";

const saveSchema = z.object({
  draftId: z.uuid().nullable(),
  expectedVersion: z.number().int().min(0).nullable(),
  values: z.record(z.string(), z.unknown()),
});

async function save(operatorId: string, input: z.infer<typeof saveSchema>): Promise<DraftActionResult> {
  const parsed = parseDraftForm(input.values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
  const { data, error } = await getSupabaseAdmin().rpc("admin_save_salon_draft", {
    p_actor_user_id: operatorId,
    p_draft_id: input.draftId,
    p_expected_version: input.expectedVersion,
    p_fields: parsed.fields,
  });
  if (error) return { ok: false, error: "下書きを保存できませんでした。時間をおいて、もう一度お試しください。" };
  const r = data as { result: string; draft_id?: string; version?: number; salon_id?: string };
  if (r.result === "saved") return { ok: true, draftId: r.draft_id!, version: Number(r.version ?? 0) };
  if (r.result === "conflict") return { ok: false, conflict: true, error: CONFLICT_ERROR };
  if (r.result === "registered") return { ok: false, error: "この下書きは本登録済みです。", registeredSalonId: r.salon_id };
  if (r.result === "not_found") return { ok: false, error: "下書きが見つかりません。" };
  if (r.result.startsWith("invalid:")) {
    return { ok: false, fieldErrors: { [draftFieldOf(r.result.slice("invalid:".length))]: "入力内容をご確認ください。" } };
  }
  return { ok: false, error: "下書きを保存できませんでした。" };
}

export async function saveDraftAction(input: z.infer<typeof saveSchema>): Promise<DraftActionResult> {
  const operator = await requireOperator();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力内容をご確認ください。" };
  const result = await save(operator.userId, parsed.data);
  if (result.ok) {
    revalidatePath("/ops/salons");
    revalidatePath(`/ops/salons/drafts/${result.draftId}`);
  }
  return result;
}

export type AccountPreview =
  | { kind: "new" }
  | { kind: "unconfirmed" }
  | { kind: "verified" }
  | { kind: "blocked"; reason: "operator" | "has_salon" | "unverified" | "ambiguous"; salonId?: string; salonName?: string };

export type PreviewResult =
  | { ok: true; draftId: string; version: number; account: AccountPreview }
  | { ok: false; error?: string; fieldErrors?: Record<string, string>; conflict?: boolean; draftId?: string; version?: number };

/** 「内容を確認」: 下書きを保存してから、本登録に足りない項目と、紐付け先のアカウントを調べる(まだ何も作らない)。 */
export async function previewRegistrationAction(input: z.infer<typeof saveSchema>): Promise<PreviewResult> {
  const operator = await requireOperator();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力内容をご確認ください。" };
  const saved = await save(operator.userId, parsed.data);
  if (!saved.ok) return saved;
  revalidatePath("/ops/salons");
  const draft = await getDraft(saved.draftId);
  if (!draft) return { ok: false, error: "下書きが見つかりません。" };
  const missing = missingForRegistration({
    contact_name: draft.contactName,
    login_email: draft.loginEmail,
    plan: draft.plan,
    service_status: draft.serviceStatus,
  });
  if (Object.keys(missing).length > 0) {
    return { ok: false, fieldErrors: missing, draftId: saved.draftId, version: saved.version, error: "下書きを保存しました。本登録には、次の項目が必要です。" };
  }
  const account = await lookupLoginAccount(getSupabaseAdmin(), operator.userId, draft.loginEmail!);
  const preview: AccountPreview =
    account.kind === "blocked" ? account : account.kind === "new" ? { kind: "new" } : { kind: account.kind };
  return { ok: true, draftId: saved.draftId, version: saved.version, account: preview };
}

export type RegisterResult =
  | { ok: true; salonId: string; alreadyRegistered: boolean; notice: InvitationSendResult | null }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; conflict?: boolean; existingSalonId?: string };

const registerSchema = z.object({ draftId: z.uuid(), expectedVersion: z.number().int().min(0) });
const SLUG_ATTEMPTS = 5;

/**
 * 「登録して招待メールを送信」。順に行う(途中で失敗しても、もう一度実行すれば重複せずに続きから進む):
 *   1. 紐付け先のアカウントを用意する(新しいアドレス: パスワード無しで作る / 未確認: パスワードを無効にする)
 *   2. 本登録(DB: 店舗・個別設定・招待の行・履歴を1つのトランザクションで。同じ下書きは同じ店舗を返す)
 *   3. 初回の案内を送る(送信だけ失敗しても、店舗は登録済みのまま。詳細の画面から再送できる)
 */
export async function registerSalonAction(input: z.infer<typeof registerSchema>): Promise<RegisterResult> {
  const operator = await requireOperator();
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力内容をご確認ください。" };
  const admin = getSupabaseAdmin();
  const draft = await getDraft(parsed.data.draftId);
  if (!draft) return { ok: false, error: "下書きが見つかりません。" };
  if (draft.status === "registered" && draft.salonId) return { ok: true, salonId: draft.salonId, alreadyRegistered: true, notice: null };
  if (draft.version !== parsed.data.expectedVersion) return { ok: false, conflict: true, error: CONFLICT_ERROR };
  const missing = missingForRegistration({
    contact_name: draft.contactName,
    login_email: draft.loginEmail,
    plan: draft.plan,
    service_status: draft.serviceStatus,
  });
  if (Object.keys(missing).length > 0) return { ok: false, error: "本登録に必要な項目がそろっていません。", fieldErrors: missing };

  let prepared;
  try {
    prepared = await prepareLoginAccount(admin, operator.userId, draft.loginEmail!);
  } catch {
    return { ok: false, error: "ログイン用のアカウントを用意できませんでした。時間をおいて、もう一度お試しください。" };
  }
  if (!prepared.ok) {
    const a = prepared.account;
    if (a.reason === "has_salon") return { ok: false, error: "このメールアドレスのアカウントは、すでに店舗を持っています。", existingSalonId: a.salonId };
    if (a.reason === "operator") return { ok: false, error: "運営管理のアカウントは、店舗の所有者にできません。" };
    if (a.reason === "unverified") {
      return { ok: false, error: "このアカウントは本人確認が済んでいません。本人がログイン画面から本人確認を済ませると登録できます。" };
    }
    return { ok: false, error: "このメールアドレスのアカウントを特定できません。運営の担当者に確認してください。" };
  }

  const requestId = randomUUID();
  let salonId: string | null = null;
  let alreadyRegistered = false;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS && !salonId; attempt++) {
    const { data, error } = await admin.rpc("admin_register_salon", {
      p_actor_user_id: operator.userId,
      p_draft_id: draft.id,
      p_expected_version: draft.version,
      p_owner_user_id: prepared.userId,
      p_slug: generateRandomSlug(),
      p_request_id: requestId,
    });
    if (error) return { ok: false, error: "本登録に失敗しました。時間をおいて、もう一度お試しください。" };
    const r = data as { result: string; salon_id?: string };
    if (r.result === "slug_taken") continue;
    if (r.result === "registered") salonId = r.salon_id!;
    else if (r.result === "already_registered") {
      salonId = r.salon_id ?? null;
      alreadyRegistered = true;
      if (!salonId) return { ok: false, error: "この下書きは本登録済みです。" };
    } else if (r.result === "conflict") return { ok: false, conflict: true, error: CONFLICT_ERROR };
    else if (r.result === "owner_has_salon") return { ok: false, error: "このメールアドレスのアカウントは、すでに店舗を持っています。", existingSalonId: r.salon_id };
    else if (r.result === "owner_is_operator") return { ok: false, error: "運営管理のアカウントは、店舗の所有者にできません。" };
    else if (r.result === "owner_unverified") {
      return { ok: false, error: "このアカウントは本人確認が済んでいません。本人がログイン画面から本人確認を済ませると登録できます。" };
    } else if (r.result.startsWith("incomplete:")) {
      return { ok: false, error: "本登録に必要な項目がそろっていません。", fieldErrors: { [draftFieldOf(r.result.slice("incomplete:".length))]: "本登録に必要です。" } };
    } else return { ok: false, error: "本登録に失敗しました。画面を再読み込みして、内容を確認してください。" };
  }
  if (!salonId) return { ok: false, error: "本登録に失敗しました。時間をおいて、もう一度お試しください。" };

  revalidatePath("/ops/salons");
  revalidatePath(`/ops/salons/${salonId}`);
  if (alreadyRegistered) return { ok: true, salonId, alreadyRegistered: true, notice: null };
  const notice = await sendInvitationNotice({ admin }, { operatorId: operator.userId, salonId, requestId });
  revalidatePath(`/ops/salons/${salonId}`);
  return { ok: true, salonId, alreadyRegistered: false, notice };
}
