import { SHOWCASE_IMAGE_MAX_BYTES, type ShowcaseImageType } from "@/lib/reviewShowcase/settings";

// アップロードされた写真の形式を、ファイルの先頭のバイトで確かめる(ブラウザが付けた Content-Type や
// ファイル名は信用しない)。JPEG / PNG / WebP だけを受け付ける。

export type ImageCheck = { ok: true; type: ShowcaseImageType } | { ok: false; error: string };

export function detectImageType(bytes: Uint8Array): ShowcaseImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export function checkShowcaseImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, error: "写真を読み込めませんでした。別の写真をお試しください。" };
  if (bytes.length > SHOWCASE_IMAGE_MAX_BYTES) {
    return { ok: false, error: "写真のサイズが大きすぎます。別の写真をお試しください。" };
  }
  const type = detectImageType(bytes);
  if (!type) return { ok: false, error: "JPEG・PNG・WebP の写真を選んでください。" };
  return { ok: true, type };
}
