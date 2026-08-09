"use client";

import { useState } from "react";
import Toast from "@/components/Toast";
import { copyToClipboard } from "@/lib/copyToClipboard";

export default function CopyUrlButton({ url }: { url: string }) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  async function handleCopy() {
    const ok = await copyToClipboard(url);
    setToastMessage(ok ? "コピーしました" : "コピーできませんでした");
  }

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded-lg bg-sage px-4 py-2 text-sm font-medium text-white transition hover:bg-sage-dark"
      >
        URLをコピー
      </button>
      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </>
  );
}
