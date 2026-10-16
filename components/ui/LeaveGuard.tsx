"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";

// 保存していない入力があるときに、画面を離れる前に確認する(docs/plans/google-reviews-inbox-plan.md §8-5)。
//   ・ブラウザのタブを閉じる・再読み込み・外部サイトへの移動: beforeunload(文言はブラウザ既定)
//   ・アプリ内のリンク(サイドバー・サブナビなど): クリックを止めて確認のダイアログを出す
// ブラウザの「戻る」ボタンによるアプリ内の移動は止められない(App Router に止める仕組みが無いため)。
// そのため画面にも「保存されません」と常に表示しておく(貼り付け型の入力は、同じタブで戻ったときだけ
// メモリから復元する。lib/replyGeneration/draftMemory.ts)。
interface LeaveGuardProps {
  when: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 「移動する」を選んだときに、移動の前に呼ぶ(一時的に覚えていた入力を消すなど)。 */
  onConfirmLeave?: () => void;
}

function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export default function LeaveGuard({
  when,
  title = "この画面を離れますか？",
  message,
  confirmLabel = "移動する",
  cancelLabel = "この画面に残る",
  onConfirmLeave,
}: LeaveGuardProps) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!when) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 古いブラウザ向け(値は表示されない)。
      e.returnValue = "";
    };

    // React(Next.js の Link)より先に受け取れるよう、document の capture で受ける。
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || !isPlainLeftClick(e)) return;
      const anchor = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return; // 外部サイトは beforeunload に任せる
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [when]);

  return (
    <Dialog
      open={pendingHref !== null}
      title={title}
      onClose={() => setPendingHref(null)}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => setPendingHref(null)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            onClick={() => {
              const href = pendingHref;
              setPendingHref(null);
              onConfirmLeave?.();
              if (href) router.push(href);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-ink-muted">{message}</p>
    </Dialog>
  );
}
