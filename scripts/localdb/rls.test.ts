// 0024 の表・関数に、ブラウザ(anon / authenticated)から触れないこと。PostgREST と同じく、ロールと
// request.jwt.claims(sub・session_id)を設定して確かめる(0025 からオーナーの RLS は信頼できるセッションを見る)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { adminSave, createOperator, createSalon, createSession, makeReservationActive, type SalonFixture } from "./fixtures";

const DB = "salonpack_localdb_rls";
let sql: Sql;
let operator: string;
let mine: SalonFixture;
let other: SalonFixture;
const claimsOf = new Map<string, string>();

beforeAll(async () => {
  sql = await createDatabase(DB);
  operator = await createOperator(sql);
  mine = await createSalon(sql, { plan: "salonpack" });
  other = await createSalon(sql, { plan: "salonpack" });
  for (const s of [mine, other]) {
    await adminSave(sql, { actor: operator, salonId: s.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: { blog: "inherit" } }, changes: { overrides: { blog: "deny" } } });
  }
  await makeReservationActive(sql, mine.salonId);
  for (const s of [mine, other]) claimsOf.set(s.userId, (await createSession(sql, s.userId)).claims);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

/** ロールを切り替えたトランザクションで fn を実行し、最後に必ず取り消す。 */
async function as<T>(role: "anon" | "authenticated", userId: string | null, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T;
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      if (userId) {
        await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
        await tx`select set_config('request.jwt.claims', ${claimsOf.get(userId) ?? JSON.stringify({ sub: userId })}, true)`;
      }
      result = await fn(tx);
      throw new Error("__rollback__");
    })
    .catch((e) => {
      if ((e as Error).message !== "__rollback__") throw e;
    });
  return result!;
}

async function denied(role: "anon" | "authenticated", userId: string | null, query: (tx: TransactionSql) => Promise<unknown>) {
  let error: unknown = null;
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      if (userId) {
        await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
        await tx`select set_config('request.jwt.claims', ${claimsOf.get(userId) ?? JSON.stringify({ sub: userId })}, true)`;
      }
      try {
        await query(tx);
      } catch (e) {
        error = e;
      }
      throw new Error("__rollback__");
    })
    .catch((e) => {
      if ((e as Error).message !== "__rollback__") throw e;
    });
  return error;
}

describe("オーナーのセッション(authenticated)", () => {
  it("自店舗の個別設定だけ読める", async () => {
    const rows = await as("authenticated", mine.userId, (tx) => tx`select salon_id, feature_key, mode from public.salon_feature_overrides`);
    expect(rows).toEqual([{ salon_id: mine.salonId, feature_key: "blog", mode: "deny" }]);
  });

  it("個別設定を書けない(自分に許可を付けられない)", async () => {
    expect(await denied("authenticated", mine.userId, (tx) => tx`update public.salon_feature_overrides set mode = 'allow' where salon_id = ${mine.salonId}`)).toBeTruthy();
    expect(await denied("authenticated", mine.userId, (tx) => tx`delete from public.salon_feature_overrides where salon_id = ${mine.salonId}`)).toBeTruthy();
    expect(
      await denied("authenticated", mine.userId, (tx) => tx`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${mine.salonId}, 'reservation_notifications', 'allow')`),
    ).toBeTruthy();
  });

  it("自分を管理者にできない・管理用の表を読めない", async () => {
    expect(await denied("authenticated", mine.userId, (tx) => tx`insert into public.operator_admins (user_id, granted_by) values (${mine.userId}, 'self')`)).toBeTruthy();
    for (const table of ["operator_admins", "operator_audit_log", "salon_entitlement_state", "salon_feature_holds"]) {
      expect(await denied("authenticated", mine.userId, (tx) => tx.unsafe(`select * from public.${table}`))).toBeTruthy();
    }
    expect(await denied("authenticated", mine.userId, (tx) => tx`update public.feature_catalog set lifecycle = 'available'`)).toBeTruthy();
    expect(await denied("authenticated", mine.userId, (tx) => tx`insert into public.plan_feature_rules (plan, feature_key, default_enabled) values ('reviews', 'blog', true)`)).toBeTruthy();
  });

  it("契約(salons.plan)を書き換えられない(0011 のまま)", async () => {
    expect(await denied("authenticated", mine.userId, (tx) => tx`update public.salons set plan = 'reviews' where id = ${mine.salonId}`)).toBeTruthy();
  });

  it("管理用の関数を実行できない", async () => {
    const calls: Array<(tx: TransactionSql) => Promise<unknown>> = [
      (tx) => tx`select public.admin_update_salon_entitlements(${mine.userId}, ${mine.salonId}, 0, '{}'::jsonb, '{}'::jsonb, null, null)`,
      (tx) => tx`select public.feature_hold_release(${mine.userId}, ${mine.salonId}, 'reservation_notifications', null, null, null)`,
      (tx) => tx`select * from public.admin_list_salons(null, null, null, null, null, null, 50)`,
      (tx) => tx`select * from public.admin_get_salon(${other.salonId})`,
      (tx) => tx`select public.operator_is_active(${operator})`,
      (tx) => tx`select public.salon_feature_entitled(${mine.salonId}, 'blog')`,
      (tx) => tx`select public.entitlement_touch(${mine.salonId}, 'plan', null, null)`,
    ];
    for (const call of calls) expect(await denied("authenticated", mine.userId, call)).toBeTruthy();
  });

  it("機能カタログとプランの規則は読める", async () => {
    const rows = await as("authenticated", mine.userId, (tx) => tx`select feature_key from public.feature_catalog order by feature_key`);
    expect(rows.map((r) => r.feature_key)).toEqual(["blog", "reservation_notifications", "reviews"]);
  });
});

describe("お客様用ページ(anon)", () => {
  it("salon_public で口コミを使えるかだけ読める(理由・個別設定は読めない)", async () => {
    const rows = await as("anon", null, (tx) => tx`select id, reviews_available from public.salon_public where id = ${mine.salonId}`);
    expect(rows).toEqual([{ id: mine.salonId, reviews_available: true }]);
    expect(await denied("anon", null, (tx) => tx`select * from public.salon_feature_overrides`)).toBeTruthy();
    expect(await denied("anon", null, (tx) => tx`select * from public.salon_feature_access(${mine.salonId}, 'reviews')`)).toBeTruthy();
  });

  it("口コミを個別に利用不可にすると false になり、戻すと true に戻る", async () => {
    await adminSave(sql, { actor: operator, salonId: other.salonId, expectedVersion: 1, expected: { plan: "salonpack", overrides: { reviews: "inherit" } }, changes: { overrides: { reviews: "deny" } } });
    const off = await as("anon", null, (tx) => tx`select reviews_available from public.salon_public where id = ${other.salonId}`);
    expect(off).toEqual([{ reviews_available: false }]);
    await adminSave(sql, { actor: operator, salonId: other.salonId, expectedVersion: 2, expected: { plan: "salonpack", overrides: { reviews: "deny" } }, changes: { overrides: { reviews: "inherit" } } });
    const on = await as("anon", null, (tx) => tx`select reviews_available from public.salon_public where id = ${other.salonId}`);
    expect(on).toEqual([{ reviews_available: true }]);
  });
});
