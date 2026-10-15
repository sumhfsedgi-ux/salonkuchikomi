// 届いた口コミの画面確認用の開発サーバー(テスト用DB + 架空の Google + 架空の返信案)。
//
//   npm run dev:testdb:reviews        → http://localhost:3200
//
// 接続先は scripts/testdb/target.mjs で確かめる(.env.testdb.local。共有・本番の設定にはフォールバックしない)。
// Google は架空(lib/google/simulated.ts・lib/gbp/simulated.ts)、AI の返信案は架空の文章(lib/replyGeneration/mockGenerator.ts)。
// OpenAI・LINE・実在の Google には接続しない:
//   - OPENAI_API_KEY・OPENAI_MODEL を空にして起動する。このフォルダの .env* に OPENAI_API_KEY があれば起動しない
//     (Next.js が .env* を読み込んで、空の値の代わりに使うことを防ぐ)
//   - LINE・Google の秘密の値は buildChildEnv が無効の値にする
// 失敗・遅れ・結果不明などは app/api/dev/simulated-gbp(この開発サーバーでだけ使える)で起こす。
// 手順と確かめる項目は docs/plans/reviews-inbox-browser-check.md。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, TargetError, buildChildEnv, loadTestTarget } from "./target.mjs";

const PORT = Number(process.env.REVIEWS_DEV_PORT ?? 3200);

function stop(message) {
  console.error(`\n[dev:testdb:reviews] 起動しませんでした:${message}`);
  process.exit(1);
}

for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  const file = path.join(ROOT, name);
  if (existsSync(file) && /^\s*(export\s+)?OPENAI_API_KEY\s*=/m.test(readFileSync(file, "utf8"))) {
    stop(`${name} に OPENAI_API_KEY があります。画面確認では OpenAI に接続しないため、このフォルダの ${name} から外してください。`);
  }
}

let target;
try {
  target = loadTestTarget();
} catch (err) {
  if (err instanceof TargetError) stop(err.message);
  throw err;
}

const env = buildChildEnv(target, process.env, PORT);
env.GOOGLE_REVIEWS_OAUTH_ENABLED = "1";
env.NEXT_PUBLIC_APP_MODE = "salonpack";
env.OPENAI_API_KEY = "";
env.OPENAI_MODEL = "";

if (await fetch(`http://localhost:${PORT}/login`, { redirect: "manual" }).then(() => true, () => false)) {
  stop(`ポート ${PORT} で、すでにほかのサーバーが動いています。REVIEWS_DEV_PORT で別のポートを指定してください。`);
}

console.log(`[dev:testdb:reviews] テスト用プロジェクト ${target.ref.slice(0, 4)}… に接続します(架空の Google・架空の返信案)。http://localhost:${PORT}`);
const child = spawn("npx", ["next", "dev", "-p", String(PORT)], { env, shell: true, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
