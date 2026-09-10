"use client";

import { useState } from "react";
import Toast from "@/components/Toast";
import Button from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { copyToClipboard } from "@/lib/copyToClipboard";

interface Props {
  url: string;
  /** "button" (default, prominent) for the reviews page, "link" for a compact inline use (e.g. the home feature card). */
  variant?: "button" | "link";
  className?: string;
}

export default function CopyUrlButton({ url, variant = "button", className }: Props) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastVariant, setToastVariant] = useState<"success" | "error">("success");

  async function handleCopy() {
    const ok = await copyToClipboard(url);
    setToastVariant(ok ? "success" : "error");
    setToastMessage(ok ? "コピーしました" : "コピーできませんでした");
  }

  return (
    <>
      {variant === "button" ? (
        <Button type="button" onClick={handleCopy} size="sm" className={cn("shrink-0", className)}>
          URLをコピー
        </Button>
      ) : (
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "min-h-11 text-sm font-medium text-sage-dark underline-offset-2 transition hover:underline",
            className,
          )}
        >
          URLをコピー
        </button>
      )}
      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} variant={toastVariant} />
    </>
  );
}
