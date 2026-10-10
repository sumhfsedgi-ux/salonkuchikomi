// テスト用の Supabase プロジェクト(実接続の検証)の接続先を確かめる共通の部品。
// 予約通知の移行検証(docs/plans/lavi-notification-cutover-plan.md)で使う。
// npm run testdb:migrate・test:testdb のどれも、ここで確かめてから接続する。
// 読むのは review-app/.env.testdb.local(git の管理外)。秘密の値は画面に出さない。
// 次のどれかに当たれば止める(共有・本番の設定にはフォールバックしない)。
//   - 必要な値が無い / TEST_SUPABASE_PROJECT_REF の形が違う
//   - NEXT_PUBLIC_SUPABASE_URL・鍵(JWT 形式のとき)・TEST_DATABASE_URL の接続先が TEST_SUPABASE_PROJECT_REF と違う
//   - TEST_SUPABASE_PROJECT_REF が、共有の設定(.env.local)の接続先と同じ
// DB につないだあとは assertTestDatabase で、hmail のスキーマが無いこと(共有・本番の DB ではないこと)と、
// 以前に記録した接続先の印(testdb_meta.project)が同じであることも確かめる。

import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TESTDB_FILE = path.join(ROOT, ".env.testdb.local");
export const SHARED_FILE = path.join(ROOT, ".env.local");
export const REQUIRED = [
  "TEST_SUPABASE_PROJECT_REF",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

// 検証では使わない・動かさないもの。.env.local の値が読み込まれないよう、無効の値で上書きする。
// Google はすべて擬似の Google(lib/google/simulated.ts)、LINE ログインは擬似の LINE ログイン
// (lib/notifications/line/login/simulated.ts)で検証し、本物の Google・LINE には接続しない。
export const DISABLED = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "LINE_OA_BASIC_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_TOKEN_KEYS",
  "GOOGLE_TOKEN_KEY_CURRENT",
  "LINE_LOGIN_CHANNEL_ID",
  "LINE_LOGIN_CHANNEL_SECRET",
  "LINE_RECIPIENT_INVITES_ENABLED",
  "NEXT_PUBLIC_SUPPORT_CONTACT_URL",
  // 実送信の検証モード(lib/notifications/line/sendPolicy.ts)。通常の testdb では常に無効にする。
  "LINE_REAL_SEND_VERIFY",
  "LINE_REAL_SEND_VERIFY_DESTINATIONS",
  "NOTIFICATIONS_CRON_SECRET",
  "NOTIFICATIONS_ENCRYPTION_KEY",
  "VERCEL_OIDC_TOKEN",
];

function disabledValue(key) {
  if (key === "NOTIFICATIONS_ENCRYPTION_KEY") return randomBytes(32).toString("base64");
  // 検証のたびに新しい鍵(本番の鍵を使わない)。
  if (key === "GOOGLE_TOKEN_KEYS") return `v1:${randomBytes(32).toString("base64")}`;
  if (key === "GOOGLE_TOKEN_KEY_CURRENT") return "v1";
  if (key === "GOOGLE_CLIENT_ID") return "salonpack-testdb.apps.invalid";
  return `disabled-testdb-${randomBytes(16).toString("hex")}`;
}
// アプリには渡さない値(migration の適用・並行実行のテストだけに使う)。
export const NOT_FOR_APP = ["TEST_DATABASE_URL"];

export class TargetError extends Error {}

/** @param {string} file @returns {Record<string, string>} */
export function parseEnvFile(file) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

export function refFromSupabaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.pathname !== "/" && url.pathname !== "") || url.search || url.port) return null;
    return /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function refFromJwt(key) {
  const parts = key.split(".");
  if (parts.length !== 3) return undefined; // JWT ではない(新しい形式の鍵)。接続先は URL で決まる。
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

/**
 * DB の接続文字列(postgresql://<ユーザー>:<パスワード>@<ホスト>:<ポート>/<データベース>?…)を要素に分ける。
 * パスワードに #・/・? などの記号がそのまま入っていても読めるよう、URL としてではなく、最後の @ で分けて読む。
 * @param {string} value
 * @returns {{ user: string, password: string, host: string, port: number, database: string, params: Record<string, string> } | null}
 */
export function parseDatabaseUrl(value) {
  const raw = String(value ?? "").trim();
  const scheme = /^postgres(?:ql)?:\/\//i.exec(raw);
  if (!scheme) return null;
  const rest = raw.slice(scheme[0].length);
  const at = rest.lastIndexOf("@");
  if (at <= 0) return null;
  const userinfo = rest.slice(0, at);
  const colon = userinfo.indexOf(":");
  const rawUser = colon < 0 ? userinfo : userinfo.slice(0, colon);
  const rawPassword = colon < 0 ? "" : userinfo.slice(colon + 1);
  const hostPart = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([^?#/]+)(?:\?([^#]*))?$/.exec(rest.slice(at + 1));
  if (!rawUser || !hostPart) return null;
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  /** @type {Record<string, string>} */
  const params = {};
  for (const pair of (hostPart[4] ?? "").split("&").filter(Boolean)) {
    const [k, v = ""] = pair.split("=");
    params[decode(k)] = decode(v);
  }
  return {
    user: decode(rawUser),
    password: decode(rawPassword),
    host: hostPart[1].toLowerCase(),
    port: hostPart[2] ? Number(hostPart[2]) : 5432,
    database: decode(hostPart[3]),
    params,
  };
}

/** Supabase の DB の接続文字列(直接:db.<ref>.supabase.co / プール:ユーザー名 postgres.<ref>)から ref を取り出す。 */
export function refFromDatabaseUrl(value) {
  const parsed = parseDatabaseUrl(value);
  if (!parsed) return null;
  const host = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(parsed.host)?.[1];
  const user = /^postgres\.([a-z0-9]{20})$/.exec(parsed.user)?.[1];
  return host ?? user ?? null;
}

/**
 * postgres.js に渡す接続の設定(接続文字列を URL として渡さない。パスワードの記号で読み違えないように)。
 * @param {Record<string, string>} testdb
 */
export function databaseOptions(testdb) {
  const parsed = parseDatabaseUrl(testdb.TEST_DATABASE_URL);
  if (!parsed) throw new TargetError("TEST_DATABASE_URL を接続文字列として読み取れません。");
  return {
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    username: parsed.user,
    password: parsed.password,
    ssl: /** @type {const} */ ("require"),
    connection: { application_name: "salonpack-testdb-notifications" },
  };
}

const TEMPLATE =
  "  TEST_SUPABASE_PROJECT_REF=<テスト用プロジェクトの ref>\n" +
  "  NEXT_PUBLIC_SUPABASE_URL=https://<同じ ref>.supabase.co\n" +
  "  NEXT_PUBLIC_SUPABASE_ANON_KEY=...\n" +
  "  SUPABASE_SERVICE_ROLE_KEY=...\n" +
  "  TEST_DATABASE_URL=postgresql://...(migration の適用・並行実行のテストに使う)";

/**
 * .env.testdb.local を読み、接続先を確かめる。合わなければ TargetError(何にも接続していない)。
 * @param {{ requireDatabaseUrl?: boolean, testdbFile?: string, sharedFile?: string }} [options]
 * @returns {{ ref: string, testdb: Record<string, string>, sharedRef: string | null }}
 */
export function loadTestTarget(options = {}) {
  const testdbFile = options.testdbFile ?? TESTDB_FILE;
  const sharedFile = options.sharedFile ?? SHARED_FILE;
  if (!existsSync(testdbFile)) {
    throw new TargetError(
      `.env.testdb.local がありません。テスト用の Supabase プロジェクトの値を、次の形で書いてください(値はチャットに貼らないでください)。\n${TEMPLATE}`,
    );
  }
  const testdb = parseEnvFile(testdbFile);
  const missing = REQUIRED.filter((key) => !testdb[key]);
  if (options.requireDatabaseUrl && !testdb.TEST_DATABASE_URL) missing.push("TEST_DATABASE_URL");
  if (missing.length > 0) throw new TargetError(`.env.testdb.local に次の値がありません:${missing.join(", ")}`);

  const ref = testdb.TEST_SUPABASE_PROJECT_REF;
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new TargetError("TEST_SUPABASE_PROJECT_REF の形が正しくありません(英小文字と数字の20文字)。");
  if (refFromSupabaseUrl(testdb.NEXT_PUBLIC_SUPABASE_URL) !== ref) {
    throw new TargetError("NEXT_PUBLIC_SUPABASE_URL が https://<TEST_SUPABASE_PROJECT_REF>.supabase.co ではありません。");
  }
  for (const key of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const keyRef = refFromJwt(testdb[key]);
    if (keyRef !== undefined && keyRef !== ref) throw new TargetError(`${key} は別のプロジェクトの鍵です。`);
  }
  if (testdb.TEST_DATABASE_URL) {
    if (!parseDatabaseUrl(testdb.TEST_DATABASE_URL)) {
      throw new TargetError(
        "TEST_DATABASE_URL を接続文字列として読み取れません(postgresql://<ユーザー>:<パスワード>@<ホスト>:<ポート>/<データベース> の形か確認してください)。",
      );
    }
    if (refFromDatabaseUrl(testdb.TEST_DATABASE_URL) !== ref) {
      throw new TargetError("TEST_DATABASE_URL の接続先が TEST_SUPABASE_PROJECT_REF と一致しません。");
    }
  }

  const sharedUrl = existsSync(sharedFile) ? parseEnvFile(sharedFile).NEXT_PUBLIC_SUPABASE_URL : undefined;
  const sharedRef = sharedUrl ? refFromSupabaseUrl(sharedUrl) : null;
  if (sharedUrl && !sharedRef) {
    throw new TargetError(".env.local の NEXT_PUBLIC_SUPABASE_URL から接続先を読み取れないため、共有の環境と区別できません。");
  }
  if (sharedRef === ref) throw new TargetError("テスト用のプロジェクトが、共有の設定(.env.local)と同じ接続先です。別のプロジェクトを指定してください。");
  return { ref, testdb, sharedRef };
}

/** 検証用の開発サーバー・スクリプトに渡す環境変数。 */
export function buildChildEnv(target, parentEnv, port) {
  const { testdb, sharedRef } = target;
  const env = { ...parentEnv };
  for (const [key, value] of Object.entries(testdb)) {
    if (!NOT_FOR_APP.includes(key) && !DISABLED.includes(key)) env[key] = value;
  }
  for (const key of DISABLED) env[key] = disabledValue(key);
  env.NODE_ENV = "development";
  env.SALONPACK_VERIFY_MODE = "testdb";
  env.GOOGLE_OAUTH_SIMULATED = "1";
  env.LINE_LOGIN_SIMULATED = "1";
  env.SALONPACK_SHARED_SUPABASE_REF = sharedRef ?? "none";
  if (port) env.NEXT_PUBLIC_APP_URL = `http://localhost:${port}`;
  return env;
}

/**
 * DB につないだあとの確認(postgres.js の sql)。共有・本番の DB(hmail のスキーマがある)なら止める。
 * 以前に記録した接続先の印があれば、同じ ref であることを確かめる。
 */
export async function assertTestDatabase(sql, ref) {
  const [row] = await sql`
    select to_regnamespace('hmail') is not null as has_hmail,
           to_regclass('testdb_meta.project') is not null as has_marker`;
  if (row.has_hmail) throw new TargetError("接続先の DB に hmail のスキーマがあります。共有・本番の DB の可能性があるため止めました。");
  if (row.has_marker) {
    const marks = await sql`select ref from testdb_meta.project`;
    if (marks.length !== 1 || marks[0].ref !== ref) throw new TargetError("接続先の DB に記録した印が、TEST_SUPABASE_PROJECT_REF と一致しません。");
  }
  return { hasMarker: row.has_marker };
}
