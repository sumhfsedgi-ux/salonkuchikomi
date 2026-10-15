"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { PersonIcon } from "@/components/ui/icons";
import { useImageFailure } from "@/lib/useImageFailure";

// 口コミの投稿者のアバター(docs/plans/google-reviews-inbox-plan.md §8-4・§8-7)。
// Google の画像は複製しないので <img> で直接表示する(next/image の最適化を通さない)。
// 匿名・URL なし・読み込みに失敗したときは、頭文字(名前が無ければ人のシルエット)を出す。
interface AvatarProps {
  name: string | null;
  photoUrl: string | null;
  size?: "sm" | "md";
  className?: string;
}

export default function Avatar({ name, photoUrl, size = "sm", className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const imgRef = useImageFailure<HTMLImageElement>(() => setFailed(true), Boolean(photoUrl) && !failed);
  const dimension = size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
  const initial = name?.trim() ? [...name.trim()][0] : null;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-sage-soft font-medium text-sage-dark",
        dimension,
        className,
      )}
      aria-hidden="true"
    >
      {photoUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- Google の画像は複製・最適化しない(GBP の保存の制限)
        <img
          ref={imgRef}
          src={photoUrl}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : initial ? (
        initial
      ) : (
        <PersonIcon className="h-1/2 w-1/2" />
      )}
    </span>
  );
}
