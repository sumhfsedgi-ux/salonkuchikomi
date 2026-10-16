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

  it.each(["/privacy", "/login", "/forgot-password", "/signup", "/auth/confirm", "/onboardingx"])("未ログインでも %s はログイン画面へ転送しない", async (pathname) => {
    getClaims.mockResolvedValue({ data: null });
    const response = await updateSession(request(pathname));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it.each(["/dashboard", "/dashboard/notifications", "/dashboard/settings/google", "/onboarding/salon", "/onboarding/status", "/auth/verify"])(
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

  it("未ログインで口コミ詳細を開いたら、ログインのあとに戻れるよう next と短い時間の cookie を付ける", async () => {
    getClaims.mockResolvedValue({ data: null });
    const id = "0b5f3c1e-8a2d-4c6b-9e1f-2a3b4c5d6e7f";
    const response = await updateSession(request(`/dashboard/reviews/google/${id}`));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(`/dashboard/reviews/google/${id}`);
    const cookie = response.cookies.get("sp_return_to");
    expect(cookie?.value).toBe(`/dashboard/reviews/google/${id}`);
    expect(cookie?.httpOnly).toBe(true);
  });

  it.each(["/dashboard/reviews/google/not-a-uuid", "/dashboard/reviews/settings", "/dashboard/reviews/google/0b5f3c1e-8a2d-4c6b-9e1f-2a3b4c5d6e7f?x=1"])(
    "口コミ詳細の形でなければ戻り先を付けない(%s)",
    async (pathname) => {
      getClaims.mockResolvedValue({ data: null });
      const response = await updateSession(request(pathname));
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.search).toBe("");
      expect(response.cookies.get("sp_return_to")).toBeUndefined();
    },
  );
});
