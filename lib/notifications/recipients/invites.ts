import QRCode from "qrcode";
import { randomToken, sha256Hex } from "@/lib/google/randomness";

// LINE 通知先の招待の値と表示(DB に触れない部分)。
//   - 招待の値は推測できない乱数(32バイト)。DB には sha256 だけを保存し、値そのものはログに出さない。
//   - 招待のリンクは、値を URL のフラグメント(#以降)に入れる(/line/invite#<値>)。フラグメントは HTTP の
//     リクエストに含まれないため、サーバー・プロキシのアクセスログや Referer に残らない。ページの中で読み取り、
//     POST の本文で一度だけサーバーへ送る(lib/notifications/line/login/flow.ts)。
//   - 招待は「通知を受け取る LINE を登録する」ことだけに使え、店舗の管理画面の権限は与えない。

export const INVITE_TTL_HOURS = 24;
export const DISPLAY_NAME_MAX = 40;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateInviteToken(): string {
  return randomToken(32);
}

export function hashInviteToken(token: string): string {
  return sha256Hex(token);
}

export function isWellFormedInviteToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function inviteUrl(appOrigin: string, token: string): string {
  return `${new URL(appOrigin).origin}/line/invite#${token}`;
}

/** 表示名(SalonPack の中だけで使う。旧サービスには書き込まない)。空・長すぎるときは null。 */
export function normalizeDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.replace(/\s+/g, " ").trim();
  if (value.length === 0 || [...value].length > DISPLAY_NAME_MAX) return null;
  return value;
}

/** 招待のリンクの QR コード(SVG の data URL。<img> で表示する)。 */
export async function inviteQrDataUrl(url: string): Promise<string> {
  const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 220 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
