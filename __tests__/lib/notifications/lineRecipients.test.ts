import { describe, expect, it } from "vitest";
import {
  generateInviteToken,
  hashInviteToken,
  inviteQrDataUrl,
  inviteUrl,
  isWellFormedInviteToken,
  normalizeDisplayName,
} from "@/lib/notifications/recipients/invites";
import { buildAuthorizeUrl, checkIdTokenPayload } from "@/lib/notifications/line/login/flow";
import { sha256Hex } from "@/lib/google/randomness";
import { currentDbTimeLimitMs, withDbTimeLimit } from "@/lib/notifications/dbTimeLimit";

// LINE 通知先の招待・LINE ログインの判断(DB に触れない部分)。DB を使う登録・同時アクセス・解除は
// scripts/testdb/line-recipients.test.ts。

describe("招待の値とリンク", () => {
  it("推測できない乱数(32バイト)で、DB にはハッシュだけを保存する", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(isWellFormedInviteToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(hashInviteToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(a)).not.toContain(a);
  });

  it("リンクは値を URL のフラグメント(#以降)に入れる(リクエストのパス・アクセスログに載らない)", () => {
    const token = generateInviteToken();
    const url = new URL(inviteUrl("https://app.example.test/some/path", token));
    expect(url.origin + url.pathname).toBe("https://app.example.test/line/invite");
    expect(url.hash).toBe(`#${token}`);
    expect(url.search).toBe("");
  });

  it("不正な形の値は受け付けない", () => {
    for (const bad of ["", "short", `${generateInviteToken()}x`, "a".repeat(42) + "!", null, 42]) {
      expect(isWellFormedInviteToken(bad)).toBe(false);
    }
  });

  it("表示名は前後・連続の空白を整え、1〜40文字だけ", () => {
    expect(normalizeDisplayName("  山田   花子 ")).toBe("山田 花子");
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName("あ".repeat(41))).toBeNull();
    expect(normalizeDisplayName("あ".repeat(40))).toBe("あ".repeat(40));
  });

  it("QR コードは SVG の data URL(外部の画像を使わない)", async () => {
    const dataUrl = await inviteQrDataUrl("https://app.example.test/line/invite#abc");
    expect(dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8")).toContain("<svg");
  });
});

describe("LINE ログイン", () => {
  const config = {
    channelId: "2000000000",
    channelSecret: "secret",
    redirectUri: "https://app.example.test/api/line/login/callback",
    authorizationEndpoint: "https://access.line.me/oauth2/v2.1/authorize",
    simulated: false,
  };

  it("認可の URL: openid profile・友だち追加の案内(bot_prompt)・state・nonce・PKCE(S256)", () => {
    const url = new URL(buildAuthorizeUrl(config, { state: "s".repeat(43), nonce: "n".repeat(43), codeChallenge: "c".repeat(43) }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "2000000000",
      redirect_uri: config.redirectUri,
      state: "s".repeat(43),
      scope: "openid profile",
      nonce: "n".repeat(43),
      bot_prompt: "aggressive",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    });
  });

  it("ID トークンの検証結果: 発行者・チャネル・期限・ユーザー ID の形・nonce(保存したハッシュと照合)をすべて確かめる", () => {
    const nonce = "n".repeat(43);
    const good = { iss: "https://access.line.me", sub: `U${"a".repeat(32)}`, aud: "2000000000", exp: 2_000, nonce };
    const expected = { channelId: "2000000000", nonceHash: sha256Hex(nonce), nowSeconds: 1_000 };
    expect(checkIdTokenPayload(good, expected)).toBe(good.sub);
    expect(checkIdTokenPayload({ ...good, iss: "https://evil.example" }, expected)).toBeNull();
    expect(checkIdTokenPayload({ ...good, aud: "1999999999" }, expected)).toBeNull();
    expect(checkIdTokenPayload({ ...good, exp: 999 }, expected)).toBeNull();
    expect(checkIdTokenPayload({ ...good, sub: "not-a-line-user" }, expected)).toBeNull();
    expect(checkIdTokenPayload({ ...good, nonce: "other".repeat(9) }, expected)).toBeNull();
    expect(checkIdTokenPayload({ ...good, nonce: undefined }, expected)).toBeNull();
  });
});

describe("DB への問い合わせの時間の上限", () => {
  it("文脈ごとに設定でき、入れ子の内側が優先される。設定の無い文脈では null", async () => {
    expect(currentDbTimeLimitMs()).toBeNull();
    await withDbTimeLimit(() => 5_000, async () => {
      expect(currentDbTimeLimitMs()).toBe(5_000);
      await withDbTimeLimit(() => 700, async () => {
        await Promise.resolve();
        expect(currentDbTimeLimitMs()).toBe(700);
      });
      expect(currentDbTimeLimitMs()).toBe(5_000);
    });
    expect(currentDbTimeLimitMs()).toBeNull();
  });
});
