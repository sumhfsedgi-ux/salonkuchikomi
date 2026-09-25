"use client";

import { useState } from "react";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import { TAG_LIST_LIMITS } from "@/lib/blog/config/salon";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

export default function TagListInput({ value, onChange, placeholder }: Props) {
  const [draft, setDraft] = useState("");
  const reachedLimit = value.length >= TAG_LIST_LIMITS.maxItems;

  function addTag() {
    const trimmed = draft.trim().slice(0, TAG_LIST_LIMITS.maxItemLength);
    if (!trimmed || value.includes(trimmed) || reachedLimit) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {value.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-full bg-beige py-1 pl-3 pr-1 text-sm text-ink"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted"
                aria-label={`${tag}を削除`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {!reachedLimit && (
        <div className="flex gap-2">
          <Input
            type="text"
            value={draft}
            maxLength={TAG_LIST_LIMITS.maxItemLength}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            className="flex-1"
          />
          <Button type="button" variant="secondary" size="sm" onClick={addTag}>
            追加
          </Button>
        </div>
      )}
      <p className="mt-1 text-xs text-ink-muted">
        {reachedLimit ? `最大${TAG_LIST_LIMITS.maxItems}件まで` : `${value.length}/${TAG_LIST_LIMITS.maxItems}件`}
      </p>
    </div>
  );
}
