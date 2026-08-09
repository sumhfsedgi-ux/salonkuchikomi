"use client";

import { useState } from "react";
import Toast from "@/components/Toast";

export default function CopyUrlButton({ url }: { url: string }) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  async function handleCopy() {
    await navigator.clipboard.writeText(url);
    setToastMessage("コピーしました");
  }

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
      >
        URLをコピー
      </button>
      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </>
  );
}
