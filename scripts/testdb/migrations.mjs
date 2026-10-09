// テスト用の DB への migration の適用の本体(scripts/testdb/migrate.mjs から使う)。
// 接続先の確認(scripts/testdb/target.mjs)を済ませた接続(postgres.js の sql)だけを受け取る。
// 適用の記録は testdb_meta スキーマ(テスト用の DB にだけ作る)。1つの migration を1つのトランザクションで適用し、
// 失敗したらその migration を取り消して止める(以降は適用しない)。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, TargetError } from "./target.mjs";

export const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
/** 0020 以降は、何度実行しても同じ結果になるように書く(記録のあとに変わったら、もう一度適用できる)。 */
export const REAPPLYABLE_FROM = "0020";

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** @param {{ through?: string | null, dir?: string }} [options] */
export function listMigrationFiles(options = {}) {
  const dir = options.dir ?? MIGRATIONS_DIR;
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .filter((name) => !options.through || name.slice(0, 4) <= options.through)
    .map((name) => {
      const text = readFileSync(path.join(dir, name), "utf8");
      return { name, text, sha: sha256(text) };
    });
}

/** pg のエラーから、表示してよいものだけを取り出す(接続文字列などは出さない)。 */
export function describeError(err) {
  const e = /** @type {{ code?: string, message?: string, position?: string }} */ (err);
  return `${e.code ?? "error"} ${String(e.message ?? "").slice(0, 300)}${e.position ? ` (位置 ${e.position})` : ""}`;
}

export class MigrationError extends Error {}

/**
 * @param {import("postgres").Sql} sql 接続先を確かめた接続
 * @param {{ ref: string, files: { name: string, text: string, sha: string }[], hasMarker: boolean, apply?: boolean,
 *   reapplyChanged?: boolean, assumeThrough?: string | null, log?: (line: string) => void }} options
 */
export async function runMigrations(sql, options) {
  const log = options.log ?? ((line) => console.log(line));
  const [{ has_salons: hasSalons }] = await sql`select to_regclass('public.salons') is not null as has_salons`;
  const [{ has_log: hasLog }] = await sql`select to_regclass('testdb_meta.applied_migrations') is not null as has_log`;
  if (!options.hasMarker && hasSalons && !options.assumeThrough) {
    throw new MigrationError(
      "このプロジェクトには、記録の無い migration がすでに適用されています(public.salons があります)。" +
        "新しいプロジェクトで始めるか、手で適用した番号を --assume-applied-through=NNNN で指定してください。",
    );
  }

  const applied = new Map();
  if (hasLog) for (const row of await sql`select name, sha256 from testdb_meta.applied_migrations`) applied.set(row.name, row.sha256);
  const rows = options.files.map((f) => {
    const recorded = applied.get(f.name);
    return { ...f, state: recorded === undefined ? "pending" : recorded === f.sha ? "applied" : "changed" };
  });
  const label = { pending: "未適用", applied: "適用済み", changed: "記録のあとに変更あり" };
  for (const r of rows) log(`  ${r.name.padEnd(42)} ${label[r.state]}`);

  const changed = rows.filter((r) => r.state === "changed");
  if (changed.some((r) => r.name.slice(0, 4) < REAPPLYABLE_FROM)) {
    throw new MigrationError(
      `${REAPPLYABLE_FROM} より前の migration が、適用のあとに変わっています(${changed.map((r) => r.name).join(", ")})。新しいプロジェクトで適用し直してください。`,
    );
  }
  if (!options.apply && !options.assumeThrough) return { rows, wrote: false };

  await sql.begin(async (tx) => {
    await tx`create schema if not exists testdb_meta`;
    await tx`revoke all on schema testdb_meta from public`;
    await tx`create table if not exists testdb_meta.project (ref text primary key, marked_at timestamptz not null default now())`;
    await tx`create table if not exists testdb_meta.applied_migrations (
      name text primary key, sha256 text not null, mode text not null, applied_at timestamptz not null default now())`;
    const marks = await tx`select ref from testdb_meta.project`;
    if (marks.length === 0) await tx`insert into testdb_meta.project (ref) values (${options.ref})`;
    else if (marks.length !== 1 || marks[0].ref !== options.ref) throw new TargetError("記録した印が一致しません。");
  });

  if (options.assumeThrough) {
    for (const r of rows.filter((x) => x.name.slice(0, 4) <= options.assumeThrough && x.state === "pending")) {
      await sql`insert into testdb_meta.applied_migrations (name, sha256, mode) values (${r.name}, ${r.sha}, 'assumed')`;
      r.state = "applied";
      log(`  記録だけ(実行しない):${r.name}`);
    }
  }

  if (options.apply) {
    for (const r of rows) {
      const rerun = Boolean(options.reapplyChanged) && r.state === "changed";
      if (r.state === "applied" || (r.state === "changed" && !rerun)) continue;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(r.text);
          await tx`insert into testdb_meta.applied_migrations (name, sha256, mode) values (${r.name}, ${r.sha}, ${rerun ? "reapplied" : "applied"})
                   on conflict (name) do update set sha256 = excluded.sha256, mode = excluded.mode, applied_at = now()`;
        });
      } catch (err) {
        throw new MigrationError(`${r.name} の適用に失敗しました(この migration は取り消し、以降は適用していません):${describeError(err)}`);
      }
      r.state = "applied";
      log(`  適用しました:${r.name}${rerun ? "(もう一度)" : ""}`);
    }
  }
  return { rows, wrote: true };
}

/** 適用のあとの確認(予約通知・Google 連携の主なテーブル・関数・RLS)。 */
export async function checkSchema(sql) {
  const [row] = await sql`
    select to_regclass('public.notification_deliveries') is not null as deliveries,
           to_regclass('public.google_accounts') is not null as google_accounts,
           to_regclass('public.reservation_notification_operations') is not null as operations,
           to_regprocedure('public.notifications_claim_delivery_v2(uuid,text[],interval,interval)') is not null as claim_fn,
           to_regprocedure('public.notifications_finish_delivery(uuid,uuid,text,text,text,interval)') is not null as outcome_fn,
           (select bool_and(relrowsecurity) from pg_class
             where relnamespace = 'public'::regnamespace
               and relname in ('notification_deliveries', 'google_accounts', 'salon_google_bindings', 'google_oauth_states',
                               'google_revocations', 'reservation_notification_operations', 'salon_feature_selections')) as rls`;
  return row;
}
