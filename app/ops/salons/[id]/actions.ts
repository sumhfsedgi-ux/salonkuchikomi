"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/ops/operator";
import { FEATURE_REGISTRY, getFeatureDefinition, type FeatureKey } from "@/lib/features/registry";

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
        return { ok: false, error: `${labelOf(r.detail.slice("not_in_plan:".length))}は、この契約プランの対象外のため、個別に設定できません。` };
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
      return { ok: true, message: "権限による停止を解除しました。ほかの停止(受信OFF・お客様の利用停止・運営による停止など)は、そのまま残っています。" };
    case "not_entitled":
      return { ok: false, error: "この機能は今、利用許可がないため解除できません。先に利用許可を保存してください。" };
    case "no_hold":
    case "conflict":
      return { ok: false, error: CONFLICT_ERROR, conflict: true };
    default:
      return { ok: false, error: "解除できませんでした。" };
  }
}
