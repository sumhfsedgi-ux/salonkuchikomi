import { defineConfig } from "vitest/config";
import path from "node:path";

const rootDir = import.meta.dirname;

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "."),
      // Next.js は `import "server-only"` を内部で処理する(npmパッケージは未インストール)。
      // 素のNodeで動くテストでは解決できないため、空のモジュールに置き換える。
      "server-only": path.resolve(rootDir, "__tests__/stubs/server-only.ts"),
    },
  },
});
