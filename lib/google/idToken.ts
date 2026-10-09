import { google } from "googleapis";
import { safeEqualHex, sha256Hex } from "@/lib/google/randomness";

// id_token の検証(単なる JWT のデコードでは済ませない)。
//   1. 署名: Google の公開鍵(kid ごと)で RS256 署名を検証する。
//      googleapis(google-auth-library)の verifySignedJwtWithCertsAsync を使う。この関数は
//      署名に加えて aud(SalonPack のクライアントID)・iss(accounts.google.com /
//      https://accounts.google.com)・exp/iat(時刻のずれの許容つき)・有効期間の上限も確かめる。
//      公開鍵は本番では Google の証明書エンドポイント、テストでは差し込んだ鍵を使う。
//   2. sub: 空でない、想定した形の文字列であること(アカウントの識別に使う)。
//   3. nonce: 認可の開始時に保存した nonce のハッシュと一致すること(別の認可の id_token の流用を防ぐ)。
// ライブラリのエラーメッセージはトークンそのものを含むことがあるため、外へは理由コードだけを出す。

const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

export type IdTokenFailure = "missing" | "invalid_signature_or_claims" | "invalid_sub" | "nonce_mismatch";

export class IdTokenError extends Error {
  constructor(readonly reason: IdTokenFailure) {
    super(`id_token:${reason}`);
    this.name = "IdTokenError";
  }
}

export async function verifyGoogleIdToken(
  idToken: string | undefined,
  options: { clientId: string; expectedNonceHash: string; certs: Record<string, string> }
): Promise<VerifiedGoogleIdentity> {
  if (!idToken) throw new IdTokenError("missing");

  let payload: Record<string, unknown> | undefined;
  try {
    const client = new google.auth.OAuth2();
    const ticket = await client.verifySignedJwtWithCertsAsync(idToken, options.certs, options.clientId, GOOGLE_ISSUERS);
    payload = ticket.getPayload() as Record<string, unknown> | undefined;
  } catch {
    throw new IdTokenError("invalid_signature_or_claims");
  }
  if (!payload) throw new IdTokenError("invalid_signature_or_claims");

  const sub = payload.sub;
  if (typeof sub !== "string" || !/^[0-9A-Za-z_-]{1,255}$/.test(sub)) throw new IdTokenError("invalid_sub");

  const nonce = payload.nonce;
  if (typeof nonce !== "string" || !safeEqualHex(sha256Hex(nonce), options.expectedNonceHash)) {
    throw new IdTokenError("nonce_mismatch");
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  return { sub, email: emailVerified ? email : null, emailVerified };
}
