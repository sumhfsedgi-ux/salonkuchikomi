// 0024 までの DB(既存の店舗・アカウントがある状態)に 0025 を適用する。次を確かめる。
//   - 途中で失敗すると何も残らない(SQL Editor と同じく、ファイル全体を1回の単純クエリとして送る)
//   - 既存の店舗は無償提供になり、利用可否・予約通知の対象・停止・版数は変わらない。対象の店舗・アカウントが記録に残る
//   - 再実行しても、あとから作った店舗・アカウントは変わらない。途中まで適用した状態から全体を再実行すると、同じ最終状態になる
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase, migrationFiles } from "./db";
import { createOperator, createSalon, makeReservationActive, openHolds, openStops } from "./fixtures";

const DB = "salonpack_localdb_migration0025";
const DB_FULL = "salonpack_localdb_migration0025_full";
const DB_PARTIAL = "salonpack_localdb_migration0025_partial";
const m0025 = migrationFiles().find((f) => f.includes("0025_"))!;
const text0025 = readFileSync(m0025, "utf8");

let sql: Sql;
let activeSalonpack: string;
let downgraded: string;
let confirmedNoSalon: string;
let unconfirmedNoSalon: string;
let operator: string;

async function confirmedUser(confirmed: boolean): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, email, email_confirmed_at) values (${id}, ${`u-${id.slice(0, 8)}@example.test`}, ${confirmed ? new Date() : null})`;
  return id;
}

/** 利用可否・予約通知の対象・停止・版数(移行の前後で同じであること)。 */
async function snapshot(db: Sql) {
  const access = await db`
    select s.id, a.feature_key, a.allowed, a.reason, a.hold_open
      from public.salons s cross join lateral public.salon_feature_access_all(s.id) a

     order by s.id, a.feature_key`;
  const pollable = await db`select salon_id from public.notifications_list_pollable_salons(null) order by salon_id`;
  const holds = await db`select salon_id, feature_key, opened_at from public.salon_feature_holds order by salon_id, feature_key`;
  const stops = await db`select salon_id, kind, started_at, ended_at from public.reservation_stop_intervals order by salon_id, kind, started_at`;
  const versions = await db`select salon_id, version, committed_entitled from public.salon_entitlement_state order by salon_id`;
  return { access, pollable, holds, stops, versions };
}

/** スキーマの指紋(ポリシー・関数・権限・列・制約・トリガー)。同じ最終状態かを比べる。 */
async function fingerprint(db: Sql) {
  const policies = await db`
    select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`;
  const functions = await db`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.provolatile, md5(p.prosrc) as src,
           coalesce(p.proacl::text, '') as acl
      from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2`;
  const columns = await db`
    select table_name, column_name, column_default, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name in ('salons', 'operator_audit_log', 'account_verifications', 'account_verification_requirements')
     order by 1, 2`;
  const constraints = await db`
    select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
     where connamespace = 'public'::regnamespace order by 1, 2`;
  const triggers = await db`
    select event_object_table, trigger_name, action_timing, event_manipulation from information_schema.triggers
     where trigger_schema = 'public' order by 1, 2, 4`;
  const tables = await db`select relname, relrowsecurity, coalesce(relacl::text, '') as acl from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`;
  return { policies, functions, columns, constraints, triggers, tables };
}

beforeAll(async () => {
  sql = await createDatabase(DB, "0024");
  activeSalonpack = (await createSalon(sql, { plan: "salonpack" })).salonId;
  await makeReservationActive(sql, activeSalonpack);
  await createSalon(sql, { plan: "reviews" });
  downgraded = (await createSalon(sql, { plan: "salonpack" })).salonId;
  await makeReservationActive(sql, downgraded);
  await sql`update public.salons set plan = 'reviews' where id = ${downgraded}`;
  confirmedNoSalon = await confirmedUser(true);
  unconfirmedNoSalon = await confirmedUser(false);
  operator = await createOperator(sql);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

describe("0025 の適用(既存の店舗・アカウントがある DB)", () => {
  let before: Awaited<ReturnType<typeof snapshot>>;

  it("途中で失敗すると、何も残らない(列・表・ポリシー・履歴)", async () => {
    before = await snapshot(sql);
    await expect(sql.unsafe(`${text0025}\nselect 1 / 0;`)).rejects.toThrow();
    const [state] = await sql`
      select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salons' and column_name = 'service_status') as has_status,
             to_regclass('public.account_verifications') is not null as has_verifications,
             exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salons' and policyname = 'owner_insert') as has_owner_insert,
             (select count(*)::int from public.operator_audit_log where actor_label = 'migration:0025') as migration_logs`;
    expect(state).toEqual({ has_status: false, has_verifications: false, has_owner_insert: true, migration_logs: 0 });
    expect(await snapshot(sql)).toEqual(before);
  });

  it("既存の店舗は無償提供・既存として移行し、店舗ごとに履歴を残す", async () => {
    await sql.unsafe(text0025);
    const salons = await sql`select id, service_status, registration_source from public.salons order by id`;
    for (const s of salons) expect(s).toMatchObject({ service_status: "complimentary", registration_source: "existing" });
    const logs = await sql`select salon_id from public.operator_audit_log where actor_label = 'migration:0025' and target = 'service_status' order by salon_id`;
    expect(logs.map((l) => l.salon_id)).toEqual(salons.map((s) => s.id));
  });

  it("利用可否・予約通知の対象・停止・版数は変わらない", async () => {
    expect(await snapshot(sql)).toEqual(before);
    expect(await openHolds(sql, downgraded)).toEqual(["reservation_notifications"]);
    expect(await openStops(sql, activeSalonpack)).toEqual([]);
  });

  it("legacy として記録するのは、メールが確認済みのアカウントと店舗の所有者だけ", async () => {
    const rows = await sql<{ user_id: string }[]>`select user_id from public.account_verifications where method = 'legacy'`;
    const ids = new Set(rows.map((r) => r.user_id));
    expect(ids.has(confirmedNoSalon)).toBe(true);
    expect(ids.has(operator)).toBe(true);
    expect(ids.has(unconfirmedNoSalon)).toBe(false);
    const owners = await sql<{ user_id: string }[]>`select p.user_id from public.salons s join public.profiles p on p.id = s.owner_id`;
    for (const o of owners) expect(ids.has(o.user_id)).toBe(true);
  });

  it("再実行しても、あとから作った店舗・アカウントは変わらず、履歴・記録も増えない", async () => {
    const count = async () => {
      const [r] = await sql`
        select (select count(*)::int from public.operator_audit_log) as logs,
               (select count(*)::int from public.account_verifications) as verifications,
               (select count(*)::int from public.salons where service_status = 'complimentary') as complimentary`;
      return r;
    };
    const newUser = await confirmedUser(true);
    const [profile] = await sql<{ id: string }[]>`select id from public.profiles where user_id = ${newUser}`;
    const [salon] = await sql<{ id: string }[]>`
      insert into public.salons (owner_id, name, slug) values (${profile.id}, 'あとから', ${`late-${newUser.slice(0, 8)}`}) returning id`;
    const beforeRerun = await count();
    await sql.unsafe(text0025);
    expect(await count()).toEqual(beforeRerun);
    const [s] = await sql`select service_status, registration_source from public.salons where id = ${salon.id}`;
    expect(s).toEqual({ service_status: "pending", registration_source: "self_signup" });
    const [v] = await sql`select count(*)::int as n from public.account_verifications where user_id = ${newUser}`;
    expect(v.n).toBe(0);
  });
});

describe("途中まで適用した状態から全体を再実行しても、同じ最終状態になる", () => {
  it("初回の処理(1つの文)だけ適用したあと全体を実行した DB と、全体を1回で適用した DB の指紋が同じ", async () => {
    const full = await createDatabase(DB_FULL, "0024");
    const partial = await createDatabase(DB_PARTIAL, "0024");
    try {
      await full.unsafe(text0025);
      // 3 節の前まで(表の作成と、初回だけ行う DO ブロック)を先に適用する
      const prefix = text0025.slice(0, text0025.indexOf("-- 3. salons の列"));
      expect(prefix.length).toBeGreaterThan(100);
      await partial.unsafe(prefix);
      await partial.unsafe(text0025);
      expect(await fingerprint(partial)).toEqual(await fingerprint(full));
      // さらにもう一度全体を実行しても同じ
      await full.unsafe(text0025);
      expect(await fingerprint(partial)).toEqual(await fingerprint(full));
    } finally {
      await dropDatabase(full, DB_FULL);
      await dropDatabase(partial, DB_PARTIAL);
    }
  });
});
