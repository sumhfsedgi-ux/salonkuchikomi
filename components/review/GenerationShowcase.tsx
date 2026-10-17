"use client";

import { useState } from "react";
import type { PublicShowcase } from "@/lib/reviewShowcase/settings";
import { useImageFailure } from "@/lib/useImageFailure";

// 口コミの文章を作っている間に出す、店舗の写真1枚とキャッチコピー(店舗が設定したときだけ。0033)。
//   ・写真とコピーはまとめて出す(順番に出す演出・自動のスライド・リンク・ボタンは置かない)。
//   ・写真の後ろに緑のグラデーションを敷く。写真の読み込み中・失敗のときも、コピーはその上で読める。
//     写真の失敗で、作成や画面の切り替えは止めない(この部品の中で写真を外すだけ)。
//   ・写真の下半分は黒のグラデーションで暗くして、白い文字を読みやすくする。
//   ・「作成しています」の文字は出さない(読み上げ向けの案内は ReviewFlow の role="status" が出す)。
//   ・文字の大きさは枠の幅に合わせる(cqw)。30文字までが2行に収まる大きさで、それより長くても2行で切る。
interface Props {
  showcase: PublicShowcase;
  salonName: string;
  /** お客様ページでは画面の高さに収まるように高さを抑える。管理画面のプレビューでは false。 */
  fitViewport?: boolean;
}

export default function GenerationShowcase({ showcase, salonName, fitViewport = true }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === showcase.imageUrl;
  const imgRef = useImageFailure<HTMLImageElement>(() => setFailedUrl(showcase.imageUrl), !failed);

  return (
    <div className="flex flex-col items-center gap-4" data-testid="generation-showcase">
      <div
        className={[
          "@container relative aspect-[4/5] w-full overflow-hidden rounded-2xl bg-gradient-to-br from-sage-dark via-sage to-sage/80 shadow-sm",
          fitViewport ? "max-h-[62dvh]" : "",
        ].join(" ")}
      >
        {!failed && (
          // eslint-disable-next-line @next/next/no-img-element -- 店舗がアップロードした写真(Storage の公開URL)をそのまま出す
          <img
            ref={imgRef}
            src={showcase.imageUrl}
            alt=""
            decoding="async"
            onError={() => setFailedUrl(showcase.imageUrl)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/70 via-black/35 to-transparent"
        />
        <div className="absolute inset-x-0 bottom-0 px-[6cqw] pb-[7cqw]">
          <p className="text-[11px] font-medium tracking-[0.2em] text-white/85">{salonName}</p>
          <p className="mt-2 line-clamp-2 text-[length:min(22px,5.8cqw)] font-semibold leading-snug text-balance text-white [word-break:auto-phrase] drop-shadow-[0_1px_2px_rgb(0_0_0/0.35)]">
            {showcase.catchCopy}
          </p>
        </div>
      </div>
      <span
        aria-hidden="true"
        className="h-5 w-5 animate-spin rounded-full border-2 border-greige border-t-sage"
      />
    </div>
  );
}
