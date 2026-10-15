// 0025 までの DB(既存の店舗・テスト店舗・利用開始待ちの店舗がある状態)に 0026 を適用する。次を確かめる。
//   - 途中で失敗すると何も残らない(SQL Editor と同じく、ファイル全体を1回の単純クエリとして送る)
//   - 利用可否・予約通知の対象・停止・版数は変わらない。既存の無料提供の店舗のプラン・区分も変わらない
//   - 埋め戻し: お客様が自分で登録した利用開始待ちの店舗だけ、プランを仮の値にする
//   - 2回実行しても同じ結果(スキーマ・データ)
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase, migrationFiles } from "./db";
import { createSalon, makeReservationActive } from "./fixtures";

const DB = "salonpack_localdb_migration0026";
const m0026 = migrationFiles().find((f) => f.includes("0026_"))!;
const text0026 = readFileSync(m0026, "utf8");

let sql: Sql;
let existingActive: string;
let existingReviews: string;
let testSalon: string;
let selfPending: string;
let operatorPending: string;

/** 利用可否・予約通知の対象・停止・版数(適用の前後で同じであること)。 */
async function snapshot(db: Sql) {
  const access = await db`
    select s.id, a.feature_key, a.allowed, a.reason, a.hold_open
      from public.salons s cross join lateral public.salon_feature_access_all(s.id) a
     order by s.id, a.feature_key`;
  const pollable = await db`select salon_id from public.notifications_list_pollable_salons(null) order by salon_id`;
  const holds = await db`select salon_id, feature_key, opened_at from public.salon_feature_holds order by salon_id, feature_key`;
  const stops = await db`select salon_id, kind, started_at, ended_at from public.reservation_stop_intervals order by salon_id, kind, started_at`;
  const versions = await db`select salon_id, version, committed_entitled from public.salon_entitlement_state order by salon_id`;
  const salons = await db`select id, plan, service_status, registration_source from public.salons order by id`;
  return { access, pollable, holds, stops, versions, salons };
}

/** スキーマの指紋(関数・権限・列・制約・トリガー・表)。 */
async function fingerprint(db: Sql) {
  const functions = await db`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.provolatile, md5(p.prosrc) as src,
           coalesce(p.proacl::text, '') as acl
      from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2`;
  const columns = await db`
    select table_name, column_name, column_default, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name in ('salons', 'auth_email_cooldowns', 'self_signup_settings')
     order by 1, 2`;
  const constraints = await db`
    select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
     where connamespace = 'public'::regnamespace order by 1, 2`;
  const tables = await db`select relname, relrowsecurity, coalesce(relacl::text, '') as acl from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`;
  const data = await db`select id, plan, plan_placeholder from public.salons order by id`;
  const settings = await db`select id, open from public.self_signup_settings`;
  return { functions, columns, constraints, tables, data, settings };
}

async function insertSalon(source: "self_signup" | "operator", plan: "reviews" | "salonpack"): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, email, email_confirmed_at) values (${userId}, ${`u-${userId.slice(0, 8)}@example.test`}, now())`;
  const [profile] = await sql<{ id: string }[]>`select id from public.profiles where user_id = ${userId}`;
  const [s] = await sql<{ id: string }[]>`
    insert into public.salons (owner_id, name, slug, plan, service_status, registration_source)
    values (${profile.id}, '利用開始待ち', ${`p-${userId.slice(0, 12)}`}, ${plan}, 'pending', ${source}) returning id`;
  return s.id;
}

beforeAll(async () => {
  sql = await createDatabase(DB, "0025");
  existingActive = (await createSalon(sql, { plan: "salonpack" })).salonId;
  await makeReservationActive(sql, existingActive);
  existingReviews = (await createSalon(sql, { plan: "reviews" })).salonId;
  testSalon = (await createSalon(sql, { plan: "salonpack", serviceStatus: "test", registrationSource: "operator" })).salonId;
  selfPending = await insertSalon("self_signup", "reviews");
  operatorPending = await insertSalon("operator", "salonpack");
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

describe("0026 の適用(0025 までの DB)", () => {
  let before: Awaited<ReturnType<typeof snapshot>>;

  it("途中で失敗すると、何も残らない(列・表・関数の作り直し)", async () => {
    before = await snapshot(sql);
    const [fnBefore] = await sql`select md5(prosrc) as src from pg_proc where proname = 'create_own_salon'`;
    await expect(sql.unsafe(`${text0026}\nselect 1 / 0;`)).rejects.toThrow();
    const [state] = await sql`
      select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salons' and column_name = 'plan_placeholder') as has_placeholder,
             to_regclass('public.auth_email_cooldowns') is not null as has_cooldowns,
             to_regclass('public.self_signup_settings') is not null as has_settings`;
    expect(state).toEqual({ has_placeholder: false, has_cooldowns: false, has_settings: false });
    const [fnAfter] = await sql`select md5(prosrc) as src from pg_proc where proname = 'create_own_salon'`;
    expect(fnAfter).toEqual(fnBefore);
    expect(await snapshot(sql)).toEqual(before);
  });

  it("利用可否・予約通知の対象・停止・版数・既存の店舗のプランと区分は変わらない", async () => {
    await sql.unsafe(text0026);
    expect(await snapshot(sql)).toEqual(before);
    const existing = await sql`select plan, service_status, registration_source, plan_placeholder from public.salons
                                where id in (${existingActive}, ${existingReviews}) order by plan`;
    expect(existing).toEqual([
      { plan: "reviews", service_status: "complimentary", registration_source: "existing", plan_placeholder: false },
      { plan: "salonpack", service_status: "complimentary", registration_source: "existing", plan_placeholder: false },
    ]);
  });

  it("埋め戻し: お客様が自分で登録した利用開始待ちの店舗だけ、プランを仮の値にする。受付は閉じた状態で始まる", async () => {
    const rows = await sql<{ id: string; plan_placeholder: boolean }[]>`select id, plan_placeholder from public.salons`;
    const placeholder = new Map(rows.map((r) => [r.id, r.plan_placeholder]));
    expect(placeholder.get(selfPending)).toBe(true);
    for (const id of [existingActive, existingReviews, testSalon, operatorPending]) expect(placeholder.get(id)).toBe(false);
    expect(await sql`select id, open from public.self_signup_settings`).toEqual([{ id: 1, open: false }]);
  });

  it("2回実行しても、スキーマ・データ・受付の設定は同じ(開けた受付も閉じ直さない)", async () => {
    await sql`update public.self_signup_settings set open = true where id = 1`;
    const first = await fingerprint(sql);
    await sql.unsafe(text0026);
    expect(await fingerprint(sql)).toEqual(first);
    expect(await snapshot(sql)).toEqual(before);
  });
});
