import { afterEach, describe, expect, it, vi } from "vitest";

// SERVICE_NAME はモジュール読み込み時に決まるため、環境変数を変えてから読み込み直す。
async function loadServiceName(mode: string): Promise<string> {
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", mode);
  vi.resetModules();
  const { SERVICE_NAME } = await import("@/lib/brand");
  return SERVICE_NAME;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("サービス名", () => {
  it("reviews モードでは「口コミ465」と表示する", async () => {
    expect(await loadServiceName("reviews")).toBe("口コミ465");
  });

  it("salonpack モードでは「SalonPack」と表示する", async () => {
    expect(await loadServiceName("salonpack")).toBe("SalonPack");
  });
});
