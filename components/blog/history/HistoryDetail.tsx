"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Toast from "@/components/Toast";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { deletePostAction } from "@/app/dashboard/blog/history/actions";
import type { BlogPost } from "@/lib/blog/types";

interface Props {
  post: BlogPost;
}

export default function HistoryDetail({ post }: Props) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isPending, startTransition] = useTransition();

  async function handleCopyAll() {
    const ok = await copyToClipboard(`${post.title}\n\n${post.body}`);
    setToastMessage(ok ? "コピーしました" : "コピーできませんでした");
  }

  function handleDelete() {
    startTransition(() => {
      deletePostAction(post.id);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/blog/history" className="text-sm text-ink-muted transition hover:text-sage-dark">
        ← 一覧に戻る
      </Link>

      <Card className="flex flex-col gap-4">
        <p className="font-medium text-ink">{post.title}</p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{post.body}</p>
        <Button type="button" onClick={handleCopyAll} fullWidth className="sm:w-auto sm:px-6">
          タイトル＋本文をコピー
        </Button>
      </Card>

      {!confirmingDelete ? (
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          className="self-start text-sm text-ink-muted transition hover:text-danger"
        >
          削除
        </button>
      ) : (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-ink">本当に削除しますか？</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmingDelete(false)}
              disabled={isPending}
            >
              キャンセル
            </Button>
            <Button type="button" onClick={handleDelete} disabled={isPending}>
              {isPending ? "削除しています…" : "削除する"}
            </Button>
          </div>
        </Card>
      )}

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </div>
  );
}
