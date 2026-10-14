"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

// 運営の画面の確認ダイアログ(保存・登録の前の確認)。開いたらダイアログに移り、Esc で閉じる(処理中は閉じない)。
// 閉じたら、開く前に操作していた場所へ戻る。スマートフォンでは下から出す。
export default function ConfirmDialog({
  title,
  description,
  busy,
  onClose,
  children,
  footer,
}: {
  title: string;
  description?: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
        }}
        className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl focus:outline-none sm:rounded-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
        <div className="mt-4 flex flex-col gap-4">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-3">{footer}</div>
      </div>
    </div>
  );
}

/** 確認の項目(見出しと値)。長いメールアドレスでも崩れないように折り返す。 */
export function ConfirmRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-sm text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
