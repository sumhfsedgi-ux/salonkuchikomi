"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/ops/operator";
import { FEATURE_REGISTRY, getFeatureDefinition, type FeatureKey } from "@/lib/features/registry";
import { sendInvitationNotice } from "@/lib/onboarding/invitation";
import { authEmailErrorLabel } from "@/lib/onboarding/authEmailErrors";

// 運営管理の保存操作。どれも先頭で requireOperator()(管理者でなければ 404)。操作した管理者は、サーバーで
// 認証したユーザーの ID だけを使う(フォームの値は使わない)。DB の関数も管理者かどうかを確かめ直す。
// 保存は DB の1つのトランザクション(更新・履歴・停止の記録)。画面を開いた時点の版数と値が違えば何も書かない。

const CATALOG_KEYS = FEATURE_REGISTRY.filter((d) => d.entitlement === "catalog").map((d) => d.key) as [FeatureKey, ...FeatureKey[]];
const modeSchema = z.enum(["inherit", "allow", "deny"]);
const overridesSchema = z.partialRecord(z.enum(CATALOG_KEYS), modeSchema);
const planSchema = z.enum(["reviews", "salonpack"]);

const saveSchema = z.object({
  salonId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  expected: z.object({ plan: planSchema, overrides: overridesSchema }),
  changes: z.object({ plan: planSchema.optional(), overrides: overridesSchema.optional() }),
  note: z.string().trim().max(500, "メモは500文字以内で入力してください。").optional(),
});

export type SaveEntitlementsInput = z.input<typeof saveSchema>;
export type OpsActionResult = { ok: true; message: string; changed?: boolean } | { ok: false; error: string; conflict?: boolean };

const CONFLICT_ERROR = "ほかの操作で内容が変わっています。画面を再読み込みして、最新の内容を確認してから操作してください。";

function labelOf(key: string): string {
  try {
    return getFeatureDefinition(key as FeatureKey).label;
  } catch {
    return key;
  }
}

export async function saveEntitlementsAction(input: SaveEntitlementsInput): Promise<OpsActionResult> {
  const operator = await requireOperator();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  const { salonId, expectedVersion, expected, changes, note } = parsed.data;

  // 新しい店舗(登録の途中)が利用開始待ちのあいだ、プランは予定(契約ではない)。契約プランの変更として記録しないため、変えない(0026)。
  // 既存の店舗(0025 の時点の店舗)は、止めている間(利用開始待ち)も契約のまま。運営がプラン・利用許可を調整できる。
  // 保存しても、利用区分は変わらず、権限による停止も解除しない(再開は、区分の変更・停止の解除という別の明示的な操作だけ)。
  const { data: current, error: readError } = await getSupabaseAdmin()
    .from("salons")
    .select("service_status, registration_source")
    .eq("id", salonId)
    .maybeSingle();
  if (readError) return { ok: false, error: "保存に失敗しました。時間をおいてもう一度お試しください。" };
  if (!current) return { ok: false, error: "サロンが見つかりません。" };
  if (current.service_status === "pending" && current.registration_source !== "existing") {
    return { ok: false, error: "利用開始待ちの店舗では、契約プランと機能の利用許可は変更できません(契約プランは、利用を始めるときに決まります)。" };
  }

  const { data, error } = await getSupabaseAdmin().rpc("admin_update_salon_entitlements", {
    p_actor_user_id: operator.userId,
    p_salon_id: salonId,
    p_expected_version: expectedVersion,
    p_expected: expected,
    p_changes: changes,
    p_note: note || null,
    p_request_id: randomUUID(),
  });
  if (error) return { ok: false, error: "保存に失敗しました。時間をおいてもう一度お試しください。" };
  const r = data as { result: string; detail?: string; inflight_sends?: number };

  revalidatePath(`/ops/salons/${salonId}`);
  revalidatePath("/ops/salons");
  switch (r.result) {
    case "saved": {
      const inflight = r.inflight_sends ?? 0;
      return {
        ok: true,
        changed: true,
        message: inflight > 0 ? `保存しました。保存の時点で送信を開始していた予約通知が ${inflight} 件あり、それらは完了まで続きます。` : "保存しました。",
      };
    }
    case "no_change":
      return { ok: true, message: "変更はありませんでした。" };
    case "conflict":
      return { ok: false, error: CONFLICT_ERROR, conflict: true };
    case "not_found":
      return { ok: false, error: "サロンが見つかりません。" };
    case "invalid":
      if (r.detail?.startsWith("not_in_plan:")) {
        return { ok: false, error: `${labelOf(r.detail.slice("not_in_plan:".length))}は、この契約プランでは使えないため、変更できません。` };
      }
      return { ok: false, error: "保存できない内容が含まれています。画面を再読み込みしてください。" };
    default:
      return { ok: false, error: "保存できませんでした。" };
  }
}

const releaseSchema = z.object({
  salonId: z.uuid(),
  featureKey: z.enum(CATALOG_KEYS),
  holdId: z.uuid(),
  note: z.string().trim().max(500, "メモは500文字以内で入力してください。").optional(),
});

/** 権限による停止の解除(運営が明示的に行う)。受信ON/OFF・お客様の利用停止・運営による停止・旧側の条件は解除しない。 */
export async function releaseHoldAction(input: z.input<typeof releaseSchema>): Promise<OpsActionResult> {
  const operator = await requireOperator();
  const parsed = releaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  const { salonId, featureKey, holdId, note } = parsed.data;

  const { data, error } = await getSupabaseAdmin().rpc("feature_hold_release", {
    p_actor_user_id: operator.userId,
    p_salon_id: salonId,
    p_feature_key: featureKey,
    p_expected_hold_id: holdId,
    p_note: note || null,
    p_request_id: randomUUID(),
  });
  if (error) return { ok: false, error: "解除に失敗しました。時間をおいてもう一度お試しください。" };
  revalidatePath(`/ops/salons/${salonId}`);
  revalidatePath("/ops/salons");
  switch (data as string) {
    case "released":
      return { ok: true, message: "権限による停止を解除しました。ほかの停止(受信OFF・サロンによる利用停止・運営による停止など)は、そのまま残っています。" };
    case "not_entitled":
      return { ok: false, error: "この機能は今、利用許可がないため解除できません。先に利用許可を保存してください。" };
    case "no_hold":
    case "conflict":
      return { ok: false, error: CONFLICT_ERROR, conflict: true };
    default:
      return { ok: false, error: "解除できませんでした。" };
  }
}

const serviceStatusSchema = z.object({
  salonId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  expectedStatus: z.enum(["pending", "complimentary", "test"]),
  newStatus: z.enum(["pending", "complimentary", "test"]),
  note: z.string().trim().max(500, "メモは500文字以内で入力してください。").optional(),
});

/**
 * 利用区分の変更(運営)。通常のお客様の利用開始には使わない(将来の決済の完了で自動で始まる)。
 * できるのは、テスト用の指定(プランが決まっている店舗だけ)・利用の停止(利用開始待ちに変更)・既存の店舗を無料提供に戻すこと
 * (DB の admin_update_salon_service_status が確かめ直す)。区分だけを変え、契約プラン・機能の利用許可・権限による停止・
 * 予約通知の稼働状態は変えない(自動で開始・再開しない)。
 */
export async function saveServiceStatusAction(input: z.input<typeof serviceStatusSchema>): Promise<OpsActionResult> {
  const operator = await requireOperator();
  const parsed = serviceStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  const { salonId, expectedVersion, expectedStatus, newStatus, note } = parsed.data;
  const { data, error } = await getSupabaseAdmin().rpc("admin_update_salon_service_status", {
    p_actor_user_id: operator.userId,
    p_salon_id: salonId,
    p_expected_version: expectedVersion,
    p_expected_status: expectedStatus,
    p_new_status: newStatus,
    p_note: note || null,
    p_request_id: randomUUID(),
  });
  if (error) return { ok: false, error: "保存に失敗しました。時間をおいてもう一度お試しください。" };
  revalidatePath(`/ops/salons/${salonId}`);
  revalidatePath("/ops/salons");
  const r = data as { result: string; detail?: string; inflight_sends?: number };
  switch (r.result) {
    case "saved":
      return {
        ok: true,
        changed: true,
        message:
          "利用区分を保存しました。" +
          (r.inflight_sends ? `保存の時点で送信を始めていた予約通知が${r.inflight_sends}件あります(取り消せません)。` : ""),
      };
    case "no_change":
      return { ok: true, changed: false, message: "変更はありませんでした。" };
    case "conflict":
      return { ok: false, error: CONFLICT_ERROR, conflict: true };
    case "not_found":
      return { ok: false, error: "サロンが見つかりません。" };
    case "invalid":
      if (r.detail === "complimentary_existing_only") return { ok: false, error: "新しい店舗は無料提供にできません(無料提供は、既存の店舗だけです)。" };
      if (r.detail === "plan_required") return { ok: false, error: "プランが未定のため、テスト用にできません。" };
      return { ok: false, error: "保存できませんでした。入力内容をご確認ください。" };
    default:
      return { ok: false, error: "保存できませんでした。入力内容をご確認ください。" };
  }
}

const resendSchema = z.object({ salonId: z.uuid() });

/** 招待・案内の再送(制限: 60秒あける・24時間で10回まで。DB で確かめる)。本人確認が済んでいても、店舗登録のお知らせは送れる。 */
export async function resendInvitationAction(input: z.input<typeof resendSchema>): Promise<OpsActionResult> {
  const operator = await requireOperator();
  const parsed = resendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力内容をご確認ください。" };
  const { salonId } = parsed.data;
  const result = await sendInvitationNotice({ admin: getSupabaseAdmin() }, { operatorId: operator.userId, salonId, requestId: randomUUID() });
  revalidatePath(`/ops/salons/${salonId}`);
  revalidatePath("/ops/salons");
  switch (result.status) {
    case "accepted":
      return { ok: true, changed: true, message: "送信を受け付けました(届いたか・読まれたかは確認できません)。" };
    case "simulated":
      return { ok: true, changed: true, message: "検証モードのため、実際のメールは送信していません(記録だけ残しました)。" };
    case "failed":
      return { ok: false, error: `送信できませんでした。${authEmailErrorLabel(result.code)}` };
    case "cooldown":
      return { ok: false, error: `続けて送ることはできません。${result.retryAfterSeconds}秒ほどあけてから再送してください。` };
    case "daily_limit":
      return { ok: false, error: "24時間に送れる回数(10回)に達しました。時間をおいてから再送してください。" };
    case "no_invitation":
      return { ok: false, error: "このサロンには招待の記録がありません(お客様が自分で登録した店舗など)。" };
    case "owner_changed":
      return { ok: false, error: "所有者のアカウントが変わっているため送信できません。" };
    default:
      return { ok: false, error: "送信できませんでした。時間をおいてもう一度お試しください。" };
  }
}
