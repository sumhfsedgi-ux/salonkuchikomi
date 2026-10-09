import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Google の refresh token・PKCE の verifier を保存前に暗号化する(AES-256-GCM)。
// 鍵は GOOGLE_TOKEN_KEYS="v1:<base64 32バイト>,v2:<...>" と GOOGLE_TOKEN_KEY_CURRENT="v1" で指定する
// (鍵の入れ替えに備えて版を持つ。暗号文には key_version を一緒に保存する)。
// 追加認証データ(AAD)に「どの行・どの世代の値か」を含め、別の行・別の世代へ暗号文を
// 付け替えても復号できないようにする。値・鍵はログに出さない。

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: string;
}

export class TokenBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenBoxError";
  }
}

function parseKeyRing(): { keys: Map<string, Buffer>; current: string } {
  const raw = process.env.GOOGLE_TOKEN_KEYS;
  const current = process.env.GOOGLE_TOKEN_KEY_CURRENT;
  if (!raw || !current) {
    throw new TokenBoxError("GOOGLE_TOKEN_KEYS / GOOGLE_TOKEN_KEY_CURRENT が設定されていません。");
  }
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const colon = trimmed.indexOf(":");
    if (colon <= 0) throw new TokenBoxError("GOOGLE_TOKEN_KEYS の形式が正しくありません(v1:<base64>,v2:<base64>)。");
    const version = trimmed.slice(0, colon);
    if (!/^v\d{1,4}$/.test(version)) throw new TokenBoxError("GOOGLE_TOKEN_KEYS の版の名前が正しくありません。");
    const key = Buffer.from(trimmed.slice(colon + 1), "base64");
    if (key.length !== 32) throw new TokenBoxError("GOOGLE_TOKEN_KEYS の鍵は32バイトである必要があります。");
    keys.set(version, key);
  }
  if (!keys.has(current)) throw new TokenBoxError("GOOGLE_TOKEN_KEY_CURRENT の版が GOOGLE_TOKEN_KEYS にありません。");
  return { keys, current };
}

export function sealSecret(plaintext: string, aad: string): SealedSecret {
  const { keys, current } = parseKeyRing();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keys.get(current)!, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: current,
  };
}

export function openSecret(sealed: SealedSecret, aad: string): string {
  const { keys } = parseKeyRing();
  const key = keys.get(sealed.keyVersion);
  if (!key) throw new TokenBoxError("保存されている鍵の版が、現在の鍵の設定にありません。");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // 鍵・AAD・暗号文のどれかが合わない(付け替え・改ざん・鍵の取り違え)。詳細は出さない。
    throw new TokenBoxError("暗号化された値を復号できません。");
  }
}

export const refreshTokenAad = (accountId: string, generation: number) =>
  `google_refresh:v1:${accountId}:${generation}`;

export const pkceVerifierAad = (stateHash: string, userId: string, salonId: string) =>
  `google_pkce:v1:${stateHash}:${userId}:${salonId}`;
