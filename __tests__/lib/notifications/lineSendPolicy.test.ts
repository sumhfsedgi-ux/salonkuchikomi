// 実際の LINE 送信を、本番以外(開発・テスト用DB・擬似・プレビュー)ではサーバー側で止めることの確認。
// 実送信用のトークンが誤って設定されていても、送信の HTTP 処理(SDK の送信・fetch)が一度も呼ばれないことを確かめる。
// 本番・検証モードの確認でも、SDK の送信は差し替えて、外部には接続しない。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagingApi } from "@line/bot-sdk";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const DEST_1 = `U${"1".repeat(32)}`;
const DEST_2 = `U${"2".repeat(32)}`;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/notifications/access", () => ({
  resolveAccessibleSalon: vi.fn(async () => ({ ok: true, salon: { id: SALON_ID }, userId: "user-1" })),
}));
vi.mock("@/lib/notifications/recipients/db", () => ({ setMasterEnabled: vi.fn() }));
vi.mock("@/lib/notifications/db/operations", () => ({ customerStartReservationNotifications: vi.fn() }));
vi.mock("@/lib/notifications/db/lineConnections", () => ({
  listLineConnections: vi.fn(async () => [
    { id: "lc-1", salonId: SALON_ID, destinationId: DEST_1, label: "1", status: "connected", newReservationEnabled: true, cancellationEnabled: true, linkedAt: null },
    { id: "lc-2", salonId: SALON_ID, destinationId: DEST_2, label: "2", status: "connected", newReservationEnabled: true, cancellationEnabled: true, linkedAt: null },
  ]),
}));
vi.mock("@/lib/notifications/db/notificationHistory", () => ({
  recordNotification: vi.fn(async () => {}),
  hasRecentTestNotification: vi.fn(async () => false),
}));

const { resolveLineSendPolicy, isRealLineSendAllowed } = await import("@/lib/notifications/line/sendPolicy");
const { pushText, LineSendBlockedError } = await import("@/lib/notifications/line/LineClient");
const { sendTestNotificationAction } = await import("@/app/dashboard/notifications/actions");
const { recordNotification, hasRecentTestNotification } = await import("@/lib/notifications/db/notificationHistory");
const { TEST_SEND_RESULT_MESSAGES, testSendNotice, testSendConfirmation } = await import("@/lib/notifications/recipients/messages");

const ENV_KEYS = [
  "NODE_ENV",
  "SALONPACK_VERIFY_MODE",
  "LINE_LOGIN_SIMULATED",
  "GOOGLE_OAUTH_SIMULATED",
  "VERCEL_ENV",
  "LINE_REAL_SEND_VERIFY",
  "LINE_REAL_SEND_VERIFY_DESTINATIONS",
] as const;

/** 環境をまっさらにしてから、指定した値だけを設定する(実送信用のトークンは常に「誤って」設定しておく)。 */
function useEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) vi.stubEnv(key, values[key] ?? "");
  vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "real-looking-channel-access-token-must-not-be-used");
}

const SIMULATED_ENVS = {
  "開発(next dev)": { NODE_ENV: "development" },
  "テスト用DBの検証(本番ビルドでも)": { NODE_ENV: "production", SALONPACK_VERIFY_MODE: "testdb" },
  "通常の testdb(開発サーバー + 擬似 Google・LINE ログイン)": {
    NODE_ENV: "development",
    SALONPACK_VERIFY_MODE: "testdb",
    GOOGLE_OAUTH_SIMULATED: "1",
    LINE_LOGIN_SIMULATED: "1",
  },
  "擬似 LINE ログインの設定がある": { NODE_ENV: "production", LINE_LOGIN_SIMULATED: "1" },
  "Vercel のプレビュー": { NODE_ENV: "production", VERCEL_ENV: "preview" },
} as const;

/**
 * 実送信の検証のフラグ(LINE_REAL_SEND_VERIFY=1)と、送ってはいけない環境が同時にある組み合わせ。
 * 宛先を検証用に指定していても、テスト用DB・擬似 Google・擬似 LINE ログインの「送らない」が優先する。
 */
const VERIFY_WITH_SIMULATION = {
  "検証フラグ + テスト用DB(開発サーバー)": { NODE_ENV: "development", SALONPACK_VERIFY_MODE: "testdb" },
  "検証フラグ + テスト用DB(本番ビルド)": { NODE_ENV: "production", SALONPACK_VERIFY_MODE: "testdb" },
  "検証フラグ + 擬似 LINE ログイン": { NODE_ENV: "production", LINE_LOGIN_SIMULATED: "1" },
  "検証フラグ + 擬似 Google": { NODE_ENV: "production", GOOGLE_OAUTH_SIMULATED: "1" },
  "検証フラグ + 通常の testdb(開発サーバー + 擬似 Google・LINE ログイン)": {
    NODE_ENV: "development",
    SALONPACK_VERIFY_MODE: "testdb",
    GOOGLE_OAUTH_SIMULATED: "1",
    LINE_LOGIN_SIMULATED: "1",
  },
} as const;
const VERIFY_FLAGS = { LINE_REAL_SEND_VERIFY: "1", LINE_REAL_SEND_VERIFY_DESTINATIONS: `${DEST_1},${DEST_2}` } as const;

let sdkSend: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sdkSend = vi
    .spyOn(messagingApi.MessagingApiClient.prototype, "pushMessageWithHttpInfo")
    .mockResolvedValue({ httpResponse: { headers: new Headers({ "x-line-request-id": "req-stub" }) }, body: {} } as never);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("外部への通信はしない"));
  vi.mocked(recordNotification).mockClear();
  vi.mocked(hasRecentTestNotification).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("実送信の可否の判定", () => {
  it("本番だけが live。開発・テスト用DB・擬似・プレビューは simulated", () => {
    expect(resolveLineSendPolicy({ NODE_ENV: "production" })).toEqual({ mode: "live" });
    expect(resolveLineSendPolicy({ NODE_ENV: "production", VERCEL_ENV: "production" })).toEqual({ mode: "live" });
    expect(resolveLineSendPolicy({ NODE_ENV: "development" })).toEqual({ mode: "simulated", reason: "development" });
    expect(resolveLineSendPolicy({ NODE_ENV: "test" })).toEqual({ mode: "simulated", reason: "development" });
    expect(resolveLineSendPolicy({ NODE_ENV: "production", SALONPACK_VERIFY_MODE: "testdb" })).toEqual({ mode: "simulated", reason: "testdb" });
    expect(resolveLineSendPolicy({ NODE_ENV: "production", GOOGLE_OAUTH_SIMULATED: "1" })).toEqual({ mode: "simulated", reason: "simulated_login" });
    expect(resolveLineSendPolicy({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toEqual({ mode: "simulated", reason: "preview" });
  });

  it("検証モードは明示的に有効にしたときだけ。指定した形の正しい宛先にだけ送れる(本番でも、ほかの宛先には送らない)", () => {
    const policy = resolveLineSendPolicy({
      NODE_ENV: "development",
      LINE_REAL_SEND_VERIFY: "1",
      LINE_REAL_SEND_VERIFY_DESTINATIONS: ` ${DEST_1} ,not-a-user-id,`,
    });
    expect(policy.mode).toBe("verify");
    expect(isRealLineSendAllowed(policy, DEST_1)).toBe(true);
    expect(isRealLineSendAllowed(policy, DEST_2)).toBe(false);
    expect(isRealLineSendAllowed(resolveLineSendPolicy({ NODE_ENV: "development", LINE_REAL_SEND_VERIFY: "1" }), DEST_1)).toBe(false);
    expect(isRealLineSendAllowed(resolveLineSendPolicy({ NODE_ENV: "production", LINE_REAL_SEND_VERIFY: "1" }), DEST_1)).toBe(false);
    expect(isRealLineSendAllowed(resolveLineSendPolicy({ NODE_ENV: "development", LINE_REAL_SEND_VERIFY: "true", LINE_REAL_SEND_VERIFY_DESTINATIONS: DEST_1 }), DEST_1)).toBe(false);
  });
});

describe("テスト用DB・擬似 Google・擬似 LINE ログインの「送らない」は、実送信の検証のフラグより優先する(宛先を指定していても送らない)", () => {
  for (const [name, env] of Object.entries(VERIFY_WITH_SIMULATION)) {
    it(name, async () => {
      expect(resolveLineSendPolicy({ ...env, ...VERIFY_FLAGS }).mode).toBe("simulated");
      useEnv({ ...env, ...VERIFY_FLAGS });
      await expect(pushText(DEST_1, "テスト", crypto.randomUUID())).rejects.toBeInstanceOf(LineSendBlockedError);
      await expect(pushText(DEST_2, "テスト", crypto.randomUUID())).rejects.toBeInstanceOf(LineSendBlockedError);
      expect(await sendTestNotificationAction()).toEqual({ ok: true, message: TEST_SEND_RESULT_MESSAGES.simulated });
      expect(sdkSend).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(recordNotification).not.toHaveBeenCalled();
    });
  }

  it("擬似の設定が無ければ、検証のフラグは開発・プレビューでも有効(指定した宛先だけ)", () => {
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "production", VERCEL_ENV: "preview" }, { NODE_ENV: "production" }]) {
      const policy = resolveLineSendPolicy({ ...env, LINE_REAL_SEND_VERIFY: "1", LINE_REAL_SEND_VERIFY_DESTINATIONS: DEST_1 });
      expect(policy.mode).toBe("verify");
      expect(isRealLineSendAllowed(policy, DEST_1)).toBe(true);
      expect(isRealLineSendAllowed(policy, DEST_2)).toBe(false);
    }
  });
});

describe("送信の入口(pushText): 擬似環境では、実送信用のトークンがあっても HTTP を一度も呼ばない", () => {
  for (const [name, env] of Object.entries(SIMULATED_ENVS)) {
    it(name, async () => {
      useEnv(env);
      await expect(pushText(DEST_1, "テスト", crypto.randomUUID())).rejects.toBeInstanceOf(LineSendBlockedError);
      expect(sdkSend).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("検証モード: 指定した宛先だけ送信の処理に進み、ほかの宛先は HTTP を呼ばない(SDK は差し替え。外部には接続しない)", async () => {
    useEnv({ NODE_ENV: "development", LINE_REAL_SEND_VERIFY: "1", LINE_REAL_SEND_VERIFY_DESTINATIONS: DEST_1 });
    await expect(pushText(DEST_2, "テスト", crypto.randomUUID())).rejects.toBeInstanceOf(LineSendBlockedError);
    expect(sdkSend).not.toHaveBeenCalled();
    expect(await pushText(DEST_1, "テスト", crypto.randomUUID())).toEqual({ outcome: "sent", requestId: "req-stub" });
    expect(sdkSend).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("本番では送信の処理に進む(判定が送信を一律に止めていないことの確認。SDK は差し替え)", async () => {
    useEnv({ NODE_ENV: "production", VERCEL_ENV: "production" });
    expect(await pushText(DEST_1, "テスト", crypto.randomUUID())).toEqual({ outcome: "sent", requestId: "req-stub" });
    expect(sdkSend).toHaveBeenCalledTimes(1);
  });
});

describe("テスト通知の画面の案内(押す前に表示する)", () => {
  it("本番: 登録済みの通知先へ実際に送ることと人数を示し、送る前に本文つきで確認する", () => {
    expect(testSendNotice("live", 2)).toBe("登録済みの通知先(2人)のLINEに、実際にテストメッセージを送ります。");
    expect(testSendConfirmation(2)).toBe("2人のLINEに、実際にテストメッセージ「予約通知の設定が完了しました」を送ります。送信してよろしいですか?");
  });
  it("擬似環境・送り先が無い検証モード: 実際には送信しないことを示す", () => {
    const simulated = "この環境では、LINEへは実際には送信しません(送信のシミュレーションだけを行います)。";
    expect(testSendNotice("simulated", 0)).toBe(simulated);
    expect(testSendNotice("verify", 0)).toBe(simulated);
    expect(testSendNotice("verify", 1)).toContain("指定した検証用の宛先(1人)にだけ");
  });
});

describe("テスト通知(sendTestNotificationAction)", () => {
  for (const [name, env] of Object.entries(SIMULATED_ENVS)) {
    it(`${name}: 「送信をシミュレーションしました(実際には送信していません)」。HTTP も履歴の記録もしない`, async () => {
      useEnv(env);
      expect(await sendTestNotificationAction()).toEqual({ ok: true, message: "送信をシミュレーションしました（実際には送信していません）" });
      expect(sdkSend).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(recordNotification).not.toHaveBeenCalled();
    });
  }

  it("検証モード: 指定した検証用の宛先にだけ送り、ほかの通知先には送らない", async () => {
    useEnv({ NODE_ENV: "development", LINE_REAL_SEND_VERIFY: "1", LINE_REAL_SEND_VERIFY_DESTINATIONS: DEST_2 });
    expect(await sendTestNotificationAction()).toEqual({ ok: true, message: TEST_SEND_RESULT_MESSAGES.verify });
    expect(sdkSend).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sdkSend).mock.calls[0][0]).toMatchObject({ to: DEST_2 });
    expect(recordNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordNotification).mock.calls[0][0]).toMatchObject({ lineConnectionId: "lc-2", status: "test" });
  });

  it("本番: 登録済みの通知先へ送る(疎通テストは維持。SDK は差し替え)", async () => {
    useEnv({ NODE_ENV: "production", VERCEL_ENV: "production" });
    expect(await sendTestNotificationAction()).toEqual({ ok: true, message: TEST_SEND_RESULT_MESSAGES.live });
    expect(sdkSend).toHaveBeenCalledTimes(2);
    expect(hasRecentTestNotification).toHaveBeenCalledTimes(1);
  });
});
