import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Supabase には接続しない。getClaims の結果(ログインしているか)だけを差し替える。
const getClaims = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims } }),
}));

const { updateSession } = await import("@/lib/supabase/proxy");

function request(pathname: string) {
  return new NextRequest(new URL(pathname, "https://salonpack.example"));
}

describe("認証の転送(Proxy)", () => {
  beforeEach(() => {
    getClaims.mockReset();
  });

  it.each(["/privacy", "/login", "/forgot-password"])("未ログインでも %s はログイン画面へ転送しない", async (pathname) => {
    getClaims.mockResolvedValue({ data: null });
    const response = await updateSession(request(pathname));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it.each(["/dashboard", "/dashboard/notifications", "/dashboard/settings/google"])(
    "未ログインの %s は今まで通りログイン画面へ転送する",
    async (pathname) => {
      getClaims.mockResolvedValue({ data: null });
      const response = await updateSession(request(pathname));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    },
  );

  it("ログイン済みなら /dashboard は転送しない", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user" } } });
    const response = await updateSession(request("/dashboard"));
    expect(response.headers.get("location")).toBeNull();
  });
});
