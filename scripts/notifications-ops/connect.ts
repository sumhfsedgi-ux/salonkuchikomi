import { existsSync } from "fs";
import path from "path";
import postgres from "postgres";

// 運用 CLI 共通: 接続文字列はリポジトリ直下の .env.hmail-migration.local(git 管理外)の DATABASE_URL から読む。
// 値は表示しない。チャットやコードに貼らない。

export function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function requireArg(name: string): string {
  const value = getArg(name);
  if (!value) {
    console.error(`--${name}=... を指定してください。`);
    process.exit(1);
  }
  return value;
}

export function parseDateArg(name: string): Date {
  const value = requireArg(name);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    console.error(`--${name} は日時(ISO 8601)で指定してください。`);
    process.exit(1);
  }
  return date;
}

export function connect(): postgres.Sql {
  const file = path.resolve(getArg("secrets-file") ?? ".env.hmail-migration.local");
  if (!existsSync(file)) {
    console.error(`${file} がありません。DATABASE_URL=(Supabase の直接接続文字列)を1行書いてください(値はチャットに貼らないでください)。`);
    process.exit(1);
  }
  process.loadEnvFile(file);
  if (!process.env.DATABASE_URL) {
    console.error(`${file} に DATABASE_URL がありません。`);
    process.exit(1);
  }
  return postgres(process.env.DATABASE_URL, { ssl: "require", max: 1, onnotice: () => {} });
}

export function operatorName(): string {
  const value = getArg("by");
  if (!value || !/^[A-Za-z0-9_.@-]{1,60}$/.test(value)) {
    console.error("--by=<作業者の名前> を指定してください(記録に残します)。");
    process.exit(1);
  }
  return `operator:${value}`;
}

export async function runCli(main: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const sql = connect();
  try {
    await main(sql);
  } catch (error) {
    // postgres.js のエラーには接続情報の断片が含まれることがあるため、メッセージだけを出す。
    console.error("止めました:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
