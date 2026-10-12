import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 予約通知の運用状態を「稼働中」にできるのは、お客様の開始(reservation_ops_customer_start)と運営のコマンド
// (reservation_ops_activate)だけであることを固定する。開始の操作で内部スイッチを先に ON にし、開始に失敗しても
// ON のまま残す設計は、これが前提(稼働中でなければ、メール確認・配信の確保・送信の直前のどれにも入らない。
// scripts/testdb/features-onboarding.test.ts)。自動で稼働中にする処理を足すときは、その設計を見直すこと。

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const migrationsDir = path.join(root, "supabase", "migrations");

function activationSites(): string[] {
  const sites: string[] = [];
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8").replace(/--.*$/gm, "");
    // 運用状態の表への update / insert のうち、state を 'active' にするもの。
    const pattern = /(update\s+public\.reservation_notification_operations[\s\S]*?;)|(insert\s+into\s+public\.reservation_notification_operations[\s\S]*?;)/gi;
    for (const match of sql.matchAll(pattern)) {
      const statement = match[0];
      if (!/state\s*=\s*'active'|'active'/i.test(statement.replace(/where[\s\S]*$/i, ""))) continue;
      const before = sql.slice(0, match.index);
      const fn = [...before.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)/gi)].at(-1)?.[1] ?? "(関数の外)";
      sites.push(`${file}:${fn}`);
    }
  }
  return sites;
}

describe("予約通知を稼働中にする経路", () => {
  it("migration の中で運用状態を稼働中にするのは、お客様の開始と運営の開始の2つの関数だけ", () => {
    const functions = new Set(activationSites().map((site) => site.split(":")[1]));
    expect([...functions].sort()).toEqual(["reservation_ops_activate", "reservation_ops_customer_start"]);
  });

  it("アプリ(app・lib)から呼ぶのはお客様の開始だけ(運営の開始は scripts/notifications-ops からだけ)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && readFileSync(full, "utf8").includes('"reservation_ops_activate"')) hits.push(full);
      }
    };
    walk(path.join(root, "app"));
    walk(path.join(root, "lib"));
    expect(hits).toEqual([]);
  });
});
