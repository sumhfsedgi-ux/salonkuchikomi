import { createHash, randomBytes } from "crypto";
import { LINE_ID_TOKEN_ISSUER } from "@/lib/notifications/line/login/config";
import { LineLoginError, type LineIdTokenPayload, type LineLoginTransport } from "@/lib/notifications/line/login/transport";

// テストと、テスト用DBでの画面確認のための擬似 LINE ログイン(本番では使えない。config.ts の
// isSimulatedLineLoginEnabled)。外部への通信は一切しない。次の振る舞いを再現する:
//   - 利用者はキャンセル(error)できる。友だち追加をしない(friendFlag=false)こともできる
//   - code は1回だけ使え、PKCE と redirect_uri が一致しなければ交換できない
//   - ID トークンの検証の結果に nonce が入る(呼び出し側がハッシュと照合する)
//   - 通信の失敗を差し込める(途中の失敗からの再試行の検証)

export interface SimulatedLineUser {
  userId: string;
  name: string;
}

export interface SimulatedLineLogin {
  channelId: string;
  users: SimulatedLineUser[];
  transport: LineLoginTransport;
  /** 許可した場合の code を返す。 */
  authorize(params: { userId: string; addFriend: boolean; nonce: string; codeChallenge: string; redirectUri: string }): string;
  /** 認可画面の URL から、そのまま許可した場合のコールバックのパラメータを作る(テスト用)。 */
  approve(authorizationUrl: string, options: { userId: string; addFriend?: boolean }): { code: string; state: string };
  failNext(op: "exchange" | "verify" | "friendship"): void;
  isFriend(userId: string): boolean;
}

export function simulatedLineUserId(seed: string): string {
  return `U${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

export function createSimulatedLineLogin(options: { channelId: string; users?: SimulatedLineUser[] }): SimulatedLineLogin {
  const users = options.users ?? [
    { userId: simulatedLineUserId("staff-a"), name: "スタッフA(擬似LINE)" },
    { userId: simulatedLineUserId("staff-b"), name: "スタッフB(擬似LINE)" },
    { userId: simulatedLineUserId("owner"), name: "オーナー(擬似LINE)" },
  ];
  const friends = new Set<string>();
  const codes = new Map<string, { userId: string; nonce: string; codeChallenge: string; redirectUri: string }>();
  const accessTokens = new Map<string, string>(); // token -> userId
  const idTokens = new Map<string, LineIdTokenPayload>();
  const failures = new Set<string>();

  function authorize(params: { userId: string; addFriend: boolean; nonce: string; codeChallenge: string; redirectUri: string }) {
    if (!users.some((u) => u.userId === params.userId)) throw new Error("simulated line: unknown user");
    if (params.addFriend) friends.add(params.userId);
    const code = `simlinecode_${randomBytes(16).toString("hex")}`;
    codes.set(code, { userId: params.userId, nonce: params.nonce, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri });
    return code;
  }

  const transport: LineLoginTransport = {
    async exchangeCode({ code, redirectUri, channelId, codeVerifier }) {
      if (failures.delete("exchange")) throw new LineLoginError("network", 503);
      const pending = codes.get(code);
      codes.delete(code);
      const challenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
      if (!pending || channelId !== options.channelId || redirectUri !== pending.redirectUri || challenge !== pending.codeChallenge) {
        throw new LineLoginError("rejected", 400);
      }
      const accessToken = `simlineaccess_${randomBytes(12).toString("hex")}`;
      const idToken = `simlineid_${randomBytes(12).toString("hex")}`;
      accessTokens.set(accessToken, pending.userId);
      idTokens.set(idToken, {
        iss: LINE_ID_TOKEN_ISSUER,
        sub: pending.userId,
        aud: options.channelId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: pending.nonce,
      });
      return { accessToken, idToken };
    },
    async verifyIdToken({ idToken, channelId }) {
      if (failures.delete("verify")) throw new LineLoginError("network", 503);
      const payload = idTokens.get(idToken);
      if (!payload || channelId !== options.channelId) throw new LineLoginError("rejected", 400);
      return payload;
    },
    async getFriendship({ accessToken }) {
      if (failures.delete("friendship")) throw new LineLoginError("network", 503);
      const userId = accessTokens.get(accessToken);
      if (!userId) throw new LineLoginError("rejected", 401);
      return { friendFlag: friends.has(userId) };
    },
  };

  return {
    channelId: options.channelId,
    users,
    transport,
    authorize,
    approve(authorizationUrl, approveOptions) {
      const url = new URL(authorizationUrl);
      const code = authorize({
        userId: approveOptions.userId,
        addFriend: approveOptions.addFriend ?? true,
        nonce: url.searchParams.get("nonce") ?? "",
        codeChallenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
      });
      return { code, state: url.searchParams.get("state") ?? "" };
    },
    failNext(op) {
      failures.add(op);
    },
    isFriend(userId) {
      return friends.has(userId);
    },
  };
}

/** 開発サーバー(テスト用DBでの画面確認)で使う、プロセス内で1つの擬似 LINE ログイン。 */
export function getDevSimulatedLineLogin(channelId: string): SimulatedLineLogin {
  const holder = globalThis as unknown as { __salonpackSimulatedLineLogin?: SimulatedLineLogin };
  if (!holder.__salonpackSimulatedLineLogin || holder.__salonpackSimulatedLineLogin.channelId !== channelId) {
    holder.__salonpackSimulatedLineLogin = createSimulatedLineLogin({ channelId });
  }
  return holder.__salonpackSimulatedLineLogin;
}
