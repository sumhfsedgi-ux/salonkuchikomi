"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { deletePostAction } from "@/app/dashboard/blog/history/actions";
import { formatDateJST } from "@/lib/blog/date";
import type { BlogPostSummary } from "@/lib/blog/types";

interface Props {
  post: BlogPostSummary;
}

export default function HistoryListItem({ post }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(() => {
      deletePostAction(post.id);
    });
  }

  if (confirming) {
    return (
      <Card className="flex flex-col gap-3">
        <p className="text-sm text-ink">「{post.title}」を削除しますか？</p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setConfirming(false)}
            disabled={isPending}
          >
            キャンセル
          </Button>
          <Button type="button" onClick={handleDelete} disabled={isPending}>
            {isPending ? "削除しています…" : "削除する"}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex items-center gap-1">
      <Link href={`/dashboard/blog/history/${post.id}`} className="min-w-0 flex-1 space-y-1">
        <p className="truncate font-medium text-ink">{post.title}</p>
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span className="truncate">{post.theme ?? "おまかせ"}</span>
          <span className="shrink-0">{formatDateJST(post.createdAt)}</span>
        </div>
      </Link>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label="この記事を削除"
        className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-muted transition hover:text-danger"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      </button>
    </Card>
  );
}
