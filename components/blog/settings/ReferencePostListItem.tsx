"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import { toggleReferencePostUseForStyleAction } from "@/app/dashboard/blog/settings/style-profile/actions";
import { formatDateJST } from "@/lib/blog/date";
import type { SalonReferencePost } from "@/lib/blog/types";

interface Props {
  post: SalonReferencePost;
}

export default function ReferencePostListItem({ post }: Props) {
  const [checked, setChecked] = useState(post.useForStyle);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    const next = !checked;
    setChecked(next); // 楽観的更新
    setPending(true);
    const result = await toggleReferencePostUseForStyleAction(post.id, next);
    if (!result.ok) {
      setChecked(!next); // 失敗時はロールバック
    }
    setPending(false);
  }

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={handleToggle}
          disabled={pending}
          aria-label={`「${post.title}」を文体プロファイルに使う`}
          className="mt-1 h-5 w-5 shrink-0 accent-sage-dark"
        />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate font-medium text-ink">{post.title}</p>
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            {post.authorName && <span className="truncate">{post.authorName}</span>}
            {post.postedAt && <span className="shrink-0">{formatDateJST(post.postedAt)}</span>}
          </div>
        </button>
      </div>

      {expanded && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{post.body}</p>
      )}
    </Card>
  );
}
