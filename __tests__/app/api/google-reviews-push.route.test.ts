import { generateKeyPairSync, sign } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Google の通知(Pub/Sub の push)の受信: 無効なら 404、検証できなければ 401、記録できてから 204(書けなければ 503)。

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const certs = { k1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const recordPush = vi.fn(async () => "recorded");
const runReviewTick = vi.fn(async () => ({}));
const afterCallbacks: (() => Promise<void>)[] = [];

vi.mock("@/lib/google/runtime", () => ({ getGoogleFlowDeps: () => ({ transport: { fetchSigningCerts: async () => certs } }) }));
vi.mock("@/lib/reviews/alerts/runtime", () => ({ getReviewAlertStore: () => ({ recordPush }), getReviewTickDeps: () => ({}) }));
vi.mock("@/lib/reviews/alerts/tick", () => ({ runReviewTick }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (cb: () => Promise<void>) => afterCallbacks.push(cb) };
});

const { POST } = await import("@/app/api/google/reviews/push/route");

const SA = "gbp-pubsub-push@salonpack-gbp.iam.gserviceaccount.com";
const AUD = "https://salonpack.example.test/api/google/reviews/push";
const SUB = "projects/salonpack-gbp/subscriptions/gbp-review-push";

function jwt(overrides: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, iat, exp: iat + 3600, sub: "1", ...overrides };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      data: Buffer.from(JSON.stringify({ type: "NEW_REVIEW", review: "accounts/1/locations/2/reviews/3" })).toString("base64"),
      messageId: "m-1",
      publishTime: "2026-10-16T00:00:00Z",
    },
    subscription: SUB,
    ...overrides,
  };
}

function call(opts: { token?: string | null; payload?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? jwt()}`;
  return POST(new NextRequest("http://localhost/api/google/reviews/push", { method: "POST", headers, body: JSON.stringify(opts.payload ?? body()) }));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  vi.stubEnv("GBP_PUBSUB_ENABLED", "1");
  vi.stubEnv("GBP_PUBSUB_AUDIENCE", AUD);
  vi.stubEnv("GBP_PUBSUB_PUSH_SA_EMAIL", SA);
  vi.stubEnv("GBP_PUBSUB_SUBSCRIPTION", SUB);
});

describe("POST /api/google/reviews/push", () => {
  it("無効・設定が足りなければ受け取らない(404)", async () => {
    vi.stubEnv("GBP_PUBSUB_ENABLED", "");
    expect((await call()).status).toBe(404);
    vi.stubEnv("GBP_PUBSUB_ENABLED", "1");
    vi.stubEnv("GBP_PUBSUB_PUSH_SA_EMAIL", "");
    expect((await call()).status).toBe(404);
    expect(recordPush).not.toHaveBeenCalled();
  });

  it("トークンが無い・検証できなければ 401。サブスクリプションが違えば 403。本文が違えば 400", async () => {
    expect((await call({ token: null })).status).toBe(401);
    expect((await call({ token: jwt({ aud: "https://other.example.test" }) })).status).toBe(401);
    expect((await call({ payload: body({ subscription: "projects/x/subscriptions/y" }) })).status).toBe(403);
    expect((await call({ payload: { message: {} } })).status).toBe(400);
    expect(recordPush).not.toHaveBeenCalled();
  });

  it("記録できてから 204 を返し、取り込みの前倒しを after() に予約する(口コミの名前は渡さない)", async () => {
    const res = await call();
    expect(res.status).toBe(204);
    expect(recordPush).toHaveBeenCalledWith({ messageId: "m-1", notificationType: "NEW_REVIEW", locationName: "locations/2", publishTime: "2026-10-16T00:00:00.000Z" });
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(runReviewTick).toHaveBeenCalledTimes(1);
  });

  it("どの店舗にも当たらない通知・済みの再送は 204 で記録だけ(前倒しはしない)", async () => {
    recordPush.mockResolvedValueOnce("ignored");
    expect((await call()).status).toBe(204);
    recordPush.mockResolvedValueOnce("duplicate_done");
    expect((await call()).status).toBe(204);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("DB に書けなければ 503(Pub/Sub が再送する)", async () => {
    recordPush.mockRejectedValueOnce(new Error("db down"));
    expect((await call()).status).toBe(503);
    expect(afterCallbacks).toHaveLength(0);
  });
});
