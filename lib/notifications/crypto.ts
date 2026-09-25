import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Gmail refresh tokenを保存前に暗号化する(hmailのlib/crypto/encryption.tsを移植)。
// 鍵はreview-app専用に新規発行したNOTIFICATIONS_ENCRYPTION_KEYを使う
// (hmail側のAPP_ENCRYPTION_KEYとは別物 -- 2つの独立したアプリで暗号鍵を
// 使い回さないため。移行時はhmail側の鍵で一度復号し、この鍵で再暗号化する)。

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const raw = process.env.NOTIFICATIONS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("NOTIFICATIONS_ENCRYPTION_KEY が設定されていません。.env.local を確認してください。");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "NOTIFICATIONS_ENCRYPTION_KEY must decode to 32 bytes (generate with: openssl rand -base64 32)"
    );
  }
  return key;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encrypt(plaintext: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(payload: EncryptedPayload): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
