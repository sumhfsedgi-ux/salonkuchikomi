import { defineConfig } from "vitest/config";
import path from "node:path";

// テスト用の Supabase プロジェクト(実接続)でだけ動かすテスト(npm run test:testdb)。通常の npm test には入れない。
// 接続先は scripts/testdb/target.mjs で確かめる(.env.testdb.local が無い・合わないときは、どこにも接続せずに失敗する)。
const rootDir = path.resolve(import.meta.dirname, "..", "..");

export default defineConfig({
  test: {
    environment: "node",
    root: rootDir,
    include: ["scripts/testdb/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      "@": rootDir,
      "server-only": path.resolve(rootDir, "__tests__/stubs/server-only.ts"),
    },
  },
});
