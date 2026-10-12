import { defineConfig } from "vitest/config";
import path from "node:path";

// ローカルの PostgreSQL で migration・DB 関数を確かめるテスト(npm run test:localdb)。通常の npm test には入れない。
// 接続先は LOCALDB_URL(localhost のみ。scripts/localdb/db.ts)。テストごとに新しい DB を作って消す。
const rootDir = path.resolve(import.meta.dirname, "..", "..");

export default defineConfig({
  test: {
    environment: "node",
    root: rootDir,
    include: ["scripts/localdb/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
});
