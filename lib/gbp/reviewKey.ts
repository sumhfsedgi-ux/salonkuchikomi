import { createHmac } from "node:crypto";

// 口コミの重複・新着の判定に使うキー。Google の口コミのリソース名(accounts/../reviews/..)を、そのまま保存せずに
// HMAC にする(SalonPack の記録として、一時保存とは別に持つ)。鍵(REVIEW_KEY_HMAC_SECRET)が無ければ作らない。
// 第2段階の口コミの LINE 通知でも、同じ作り方のキーを使う。

export class ReviewKeyConfigError extends Error {
  constructor() {
    super("REVIEW_KEY_HMAC_SECRET が設定されていないため、口コミのキーを作れません。");
    this.name = "ReviewKeyConfigError";
  }
}

export function reviewKeyFor(reviewName: string, secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new ReviewKeyConfigError();
  return createHmac("sha256", secret).update(reviewName.trim()).digest("hex");
}
