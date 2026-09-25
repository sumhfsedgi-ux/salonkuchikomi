"use client";

import { cn } from "@/lib/cn";

// blog-appのcomponents/PillSelect.tsxを昇格移植し、review-appのトークンに
// 合わせて再配色したもの。テーマ・文字量・業種・トーン等の単一選択チップに使う、
// アプリ内で唯一の汎用フォーム部品。

export interface PillSelectOption<T extends string> {
  value: T;
  label: string;
}

interface PillSelectProps<T extends string> {
  options: PillSelectOption<T>[];
  /** undefinedの場合、どのピルも選択状態にしない（例：カスタム文字数選択中）。 */
  value: T | undefined;
  onChange: (value: T) => void;
}

export default function PillSelect<T extends string>({ options, value, onChange }: PillSelectProps<T>) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "min-h-11 rounded-full border px-4 text-sm font-medium transition",
              active
                ? "border-sage bg-sage-soft text-sage-dark"
                : "border-transparent bg-beige text-ink-muted hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
