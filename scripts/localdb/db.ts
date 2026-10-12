// ローカルの PostgreSQL(開発者の手元・CI のコンテナ)で supabase/migrations を検証するための部品。
// テスト用の Supabase プロジェクト(scripts/testdb)が使えない環境でも、DB の関数・トリガー・ロックを確かめられるようにする。
// 接続先は LOCALDB_URL(既定 postgres://postgres@127.0.0.1:54329/postgres)。localhost 以外には接続しない
// (共有・本番の DB に誤って接続しないため)。Supabase の代わりに scripts/localdb/supabase-shim.sql を先に適用する。

import { readdirSync } from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SHIM = path.join(ROOT, "scripts", "localdb", "supabase-shim.sql");

export function localDbUrl(database = "postgres"): string {
  const raw = process.env.LOCALDB_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("LOCALDB_URL は localhost の PostgreSQL だけを指定できます(共有・本番の DB には接続しません)。");
  }
  url.pathname = `/${database}`;
  return url.toString();
}

export function connect(database: string, options: { max?: number } = {}): Sql {
  return postgres(localDbUrl(database), { max: options.max ?? 4, onnotice: () => {}, idle_timeout: 5 });
}

export function migrationFiles(through?: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .filter((f) => !through || f.slice(0, 4) <= through)
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

export async function applyFile(sql: Sql, file: string): Promise<void> {
  await sql.file(file);
}

/** shim とmigration(through まで)を適用した、新しい DB を作る。名前は呼び出しごとに変える。 */
export async function createDatabase(name: string, through?: string): Promise<Sql> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("invalid database name");
  const admin = connect("postgres", { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const sql = connect(name, { max: 1 });
  try {
    await applyFile(sql, SHIM);
    for (const file of migrationFiles(through)) await applyFile(sql, file);
  } finally {
    await sql.end();
  }
  return connect(name, { max: 8 });
}

export async function dropDatabase(sql: Sql, name: string): Promise<void> {
  await sql.end({ timeout: 5 });
  const admin = connect("postgres", { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end();
  }
}
