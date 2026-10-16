import { createHash } from "node:crypto";

// Google に送る返信の文章の形と、比べるためのハッシュ(本文そのものは保存しない)。
// 送る文章は、改行を \n にそろえ、前後の空白を除いたものにする。取り直した Google の返信も同じ形にしてから比べる
// (Google 側で文章がほかの形に変わった場合は一致しないので、「外で変わった」として上書きしない側に倒れる)。

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeReplyText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** 返信の文章の SHA-256。空・無いときは null(返信が無い)。 */
export function replyHash(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const normalized = normalizeReplyText(text);
  return normalized ? sha256Hex(normalized) : null;
}
