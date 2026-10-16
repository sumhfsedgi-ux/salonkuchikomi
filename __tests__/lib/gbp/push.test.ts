import { generateKeyPairSync, sign } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { parsePushBody, pushConfig, verifyPushToken, type PushConfig } from "@/lib/gbp/pushReceiver";
import {
  createSimulatedNotificationSettingApi,
  isValidTopic,
  registrationAction,
  syncNotificationRegistrations,
} from "@/lib/gbp/notificationSetting";
import { createDeadline } from "@/lib/notifications/jobs/runBudget";

const SA = "gbp-pubsub-push@salonpack-gbp.iam.gserviceaccount.com";
const AUD = "https://salonpack.example.test/api/google/reviews/push";
const TOPIC = "projects/salonpack-gbp/topics/gbp-review-events";

describe("Google の通知の受信の設定", () => {
  it("GBP_PUBSUB_ENABLED と検証に要る値がそろったときだけ受け取る", () => {
    expect(pushConfig({})).toBeNull();
    expect(pushConfig({ GBP_PUBSUB_ENABLED: "1", GBP_PUBSUB_AUDIENCE: AUD })).toBeNull();
    expect(pushConfig({ GBP_PUBSUB_ENABLED: "1", GBP_PUBSUB_AUDIENCE: AUD, GBP_PUBSUB_PUSH_SA_EMAIL: "x@example.com" })).toBeNull();
    expect(pushConfig({ GBP_PUBSUB_ENABLED: "1", GBP_PUBSUB_AUDIENCE: AUD, GBP_PUBSUB_PUSH_SA_EMAIL: SA, GBP_PUBSUB_TOPIC: TOPIC })).toEqual({
      audience: AUD,
      serviceAccountEmail: SA,
      subscription: null,
      topic: TOPIC,
    });
    expect(isValidTopic(TOPIC)).toBe(true);
    expect(isValidTopic("topics/x")).toBe(false);
  });
});

describe("OIDC トークンの検証", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certs = { k1: publicKey.export({ type: "spki", format: "pem" }).toString() };
  const config: PushConfig = { audience: AUD, serviceAccountEmail: SA, subscription: null, topic: null };

  function jwt(payload: Record<string, unknown>, key = privateKey): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key).toString("base64url");
    return `${header}.${body}.${signature}`;
  }
  function claims(overrides: Record<string, unknown> = {}) {
    const iat = Math.floor(Date.now() / 1000) - 1800; // 発行から30分(最大1時間のトークンがあり得る)
    return { iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, iat, exp: iat + 3600, sub: "1", ...overrides };
  }

  it("Google の鍵で署名され、aud・iss・サービスアカウント・確認済みのメールが合うときだけ通す", async () => {
    expect(await verifyPushToken(`Bearer ${jwt(claims())}`, config, certs)).toBe(true);
    expect(await verifyPushToken(`Bearer ${jwt(claims(), other.privateKey)}`, config, certs)).toBe(false);
    expect(await verifyPushToken(`Bearer ${jwt(claims({ aud: "https://other.example.test" }))}`, config, certs)).toBe(false);
    expect(await verifyPushToken(`Bearer ${jwt(claims({ iss: "https://evil.example.test" }))}`, config, certs)).toBe(false);
    expect(await verifyPushToken(`Bearer ${jwt(claims({ email: "someone@salonpack-gbp.iam.gserviceaccount.com" }))}`, config, certs)).toBe(false);
    expect(await verifyPushToken(`Bearer ${jwt(claims({ email_verified: false }))}`, config, certs)).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect(await verifyPushToken(`Bearer ${jwt(claims({ iat: past, exp: past + 3600 }))}`, config, certs)).toBe(false);
    expect(await verifyPushToken(null, config, certs)).toBe(false);
    expect(await verifyPushToken("Basic abc", config, certs)).toBe(false);
  });
});

describe("push の本文", () => {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

  it("messageId・種類・location を読む(口コミの名前の中の locations/{id} からも)", () => {
    const parsed = parsePushBody({
      message: {
        data: encode({ type: "NEW_REVIEW", review: "accounts/111/locations/222/reviews/333", location: "accounts/111/locations/222" }),
        messageId: "m-1",
        publishTime: "2026-10-16T01:02:03.000Z",
      },
      subscription: "projects/salonpack-gbp/subscriptions/push",
    });
    expect(parsed).toEqual({
      messageId: "m-1",
      publishTime: "2026-10-16T01:02:03.000Z",
      subscription: "projects/salonpack-gbp/subscriptions/push",
      notificationType: "NEW_REVIEW",
      locationName: "locations/222",
    });
    expect(parsePushBody({ message: { data: encode({ reviewName: "accounts/1/locations/9/reviews/2" }), messageId: "m-2" } })?.locationName).toBe("locations/9");
  });

  it("形が違えば null(messageId が無い・本文が無い)。中身が読めなくても messageId があれば受け取る(location なし)", () => {
    expect(parsePushBody(null)).toBeNull();
    expect(parsePushBody({ message: { data: encode({}) } })).toBeNull();
    expect(parsePushBody({ message: { messageId: "m-3", data: "!!!" } })).toMatchObject({ messageId: "m-3", locationName: null, notificationType: null });
  });
});

describe("通知設定の登録", () => {
  it("空なら設定、SalonPack のトピックならそのまま(種類が足りなければ足す)、ほかのツールなら触らない", () => {
    expect(registrationAction({ pubsubTopic: null, notificationTypes: [] }, TOPIC)).toBe("set");
    expect(registrationAction({ pubsubTopic: TOPIC, notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"] }, TOPIC)).toBe("keep");
    expect(registrationAction({ pubsubTopic: TOPIC, notificationTypes: ["NEW_REVIEW"] }, TOPIC)).toBe("set");
    expect(registrationAction({ pubsubTopic: "projects/other/topics/x", notificationTypes: ["NEW_REVIEW"] }, TOPIC)).toBe("foreign");
  });

  it("登録・解除を行い、ほかのツールの設定は上書きしない。結果を記録する", async () => {
    const sim = createSimulatedNotificationSettingApi({
      "accounts/foreign": { pubsubTopic: "projects/other-tool/topics/reviews", notificationTypes: ["NEW_REVIEW"] },
      "accounts/old": { pubsubTopic: TOPIC, notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"] },
    });
    const set = vi.fn(async () => {});
    const work = [
      { action: "register" as const, accountName: "accounts/new", googleAccountId: "g1", salonId: "s1" },
      { action: "register" as const, accountName: "accounts/foreign", googleAccountId: "g1", salonId: "s1" },
      { action: "unregister" as const, accountName: "accounts/old", googleAccountId: "g1", salonId: "s1" },
    ];
    const s = await syncNotificationRegistrations({
      store: { registrationWork: async () => work, setRegistration: set },
      api: sim.api,
      access: {
        binding: async () => ({ googleAccountId: "g1" }) as never,
        accessToken: async () => "token",
      },
      topic: TOPIC,
      deadline: createDeadline(45_000),
    });
    expect(s).toEqual({ registered: 1, unregistered: 1, foreign: 1, errors: 0 });
    expect(sim.settings.get("accounts/new")).toEqual({ pubsubTopic: TOPIC, notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"] });
    expect(sim.settings.get("accounts/foreign")).toEqual({ pubsubTopic: "projects/other-tool/topics/reviews", notificationTypes: ["NEW_REVIEW"] });
    expect(sim.settings.get("accounts/old")).toEqual({ pubsubTopic: null, notificationTypes: [] });
    expect(set.mock.calls).toEqual([
      ["accounts/new", "ours", "g1"],
      ["accounts/foreign", "foreign", "g1"],
      ["accounts/old", "none", "g1"],
    ]);
  });

  it("トークンが取れない・連携先が変わったら error として記録する(Google の設定は変えない)", async () => {
    const sim = createSimulatedNotificationSettingApi();
    const set = vi.fn(async () => {});
    await syncNotificationRegistrations({
      store: { registrationWork: async () => [{ action: "register", accountName: "accounts/a", googleAccountId: "g1", salonId: "s1" }], setRegistration: set },
      api: sim.api,
      access: { binding: async () => ({ googleAccountId: "g2" }) as never, accessToken: async () => "token" },
      topic: TOPIC,
      deadline: createDeadline(45_000),
    });
    expect(set).toHaveBeenCalledWith("accounts/a", "error", "g1");
    expect(sim.calls).toEqual([]);
  });
});
