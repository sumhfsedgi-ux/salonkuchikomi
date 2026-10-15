"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

// アプリ共通の確認ダイアログ(docs/plans/google-reviews-inbox-plan.md §8-7)。
// ネイティブの <dialog> を showModal() で開くので、背景は操作できず、Tab もダイアログの中に留まる。
// 見た目は Card と同じ形(角丸・細い枠・影なし)。背景だけ少し暗くする。
// 閉じたら、開く前にフォーカスがあった要素へフォーカスを戻す。
interface DialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  /** ボタン。右寄せで secondary → primary の順に並べる。 */
  footer: ReactNode;
  /** Esc・背景のクリックで閉じたときに呼ぶ。dismissible=false(送信中など)のときは閉じない。 */
  onClose: () => void;
  dismissible?: boolean;
}

export default function Dialog({ open, title, children, footer, onClose, dismissible = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Esc で閉じるのはこちらで制御する(送信中は閉じない)。
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        // ダイアログの外側(背景)をクリックしたとき。
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-white p-0 text-ink backdrop:bg-ink/30"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-sm font-semibold text-ink">
          {title}
        </h2>
        {children && <div className="text-sm text-ink">{children}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>
      </div>
    </dialog>
  );
}
