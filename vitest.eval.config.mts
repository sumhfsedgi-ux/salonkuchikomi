import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

// 口コミ生成のオフライン評価(scripts/eval/*.eval.ts)専用の設定。通常の npm test では実行しない。
// .env.local などから OPENAI_* と EVAL_* だけを読み込む(Supabase のキーなどは読み込まない)。
const rootDir = import.meta.dirname;

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/eval/**/*.eval.ts"],
    testTimeout: 60 * 60 * 1000,
    env: loadEnv("eval", rootDir, ["OPENAI_", "EVAL_"]),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "."),
      "server-only": path.resolve(rootDir, "__tests__/stubs/server-only.ts"),
    },
  },
});
