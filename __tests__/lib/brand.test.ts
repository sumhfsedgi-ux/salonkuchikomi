import { afterEach, describe, expect, it, vi } from "vitest";

// 以前は APP_MODE でサービス名を切り替えていたため、モードを変えて
// 読み込み直しても表示が変わらないことを確かめる。
async function loadBrand(mode: string) {
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", mode);
  vi.resetModules();
  return import("@/lib/brand");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("サービス名", () => {
  it.each([
    ["reviews", "reviews"],
    ["salonpack", "salonpack"],
    ["未設定", ""],
  ])("APP_MODE が %s でも「SalonPack」と表示する", async (_label, mode) => {
    const { SERVICE_NAME, SERVICE_TAGLINE } = await loadBrand(mode);
    expect(SERVICE_NAME).toBe("SalonPack");
    expect(SERVICE_TAGLINE).toBe("サロン業務を、もっとシンプルに。");
  });
});
