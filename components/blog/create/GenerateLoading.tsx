"use client";

import { useEffect, useState } from "react";
import Card from "@/components/ui/Card";

interface Props {
  variant: "create" | "adjust";
}

// create（2段階生成）は数十秒かかることがあるため、途中でひとこと変えて
// 「止まっていないか」という不安を減らす。adjust（軽微調整）は短時間で終わるため固定文言のまま。
const CREATE_MESSAGES = [
  "最近の記事と被らないように、今回の内容を考えています。",
  "自然な文章になるよう、仕上げています。",
  "もうすぐ完成します。",
] as const;

const TITLE = {
  create: "ブログを作成しています",
  adjust: "内容を調整しています",
} as const;

export default function GenerateLoading({ variant }: Props) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    if (variant !== "create") return;
    const timer = setInterval(() => {
      setMessageIndex((i) => (i + 1) % CREATE_MESSAGES.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [variant]);

  const body = variant === "create" ? CREATE_MESSAGES[messageIndex] : "少々お待ちください。";

  return (
    <Card className="flex min-h-[45vh] flex-col items-center justify-center gap-3 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-sage" />
      <p className="font-medium text-ink">{TITLE[variant]}</p>
      <p className="text-sm text-ink-muted transition-opacity duration-300">{body}</p>
    </Card>
  );
}
