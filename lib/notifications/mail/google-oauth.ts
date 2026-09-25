import { google } from "googleapis";

// (hmailの lib/mail/google-oauth.ts を移植。今回は「保存済みのrefresh_tokenで
// Gmailを読む」経路のみ必要 -- 新規のGmail接続フロー(認可URL生成・
// codeの交換)はセルフサーブ接続フロー自体が今回のスコープ外のため、
// buildGoogleAuthUrl/exchangeCodeForTokensは移植していない。将来
// セルフサーブ接続を実装する際にhmail側の実装から追加すること。)

function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が設定されていません。.env.local を確認してください。`);
  return value;
}

export function createOAuthClient() {
  return new google.auth.OAuth2(getEnvVar("GOOGLE_CLIENT_ID"), getEnvVar("GOOGLE_CLIENT_SECRET"));
}

export function createAuthorizedClient(refreshToken: string) {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export type GoogleErrorClass = "invalid_grant" | "transient";

/**
 * 投げられたエラーを分類し、呼び出し元が mail_connections.status を
 * 'needs_reconnect' へ倒すべきか(invalid_grant -- refresh tokenが死んでいる)、
 * 次回tickでそのまま再試行すればよいか(transient -- ネットワーク瞬断等)を
 * 判断できるようにする。
 */
export function classifyGoogleError(error: unknown): GoogleErrorClass {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  const status =
    error && typeof error === "object" && "code" in error
      ? Number((error as { code: unknown }).code)
      : undefined;

  if (message.includes("invalid_grant") || message.includes("unauthorized_client") || status === 401) {
    return "invalid_grant";
  }
  return "transient";
}
