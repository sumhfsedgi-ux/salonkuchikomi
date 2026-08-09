"use client";

import { useState } from "react";
import type { MultiSelectQuestion as MultiSelectQuestionType } from "@/lib/types";

interface Props {
  question: MultiSelectQuestionType;
  selected: string[];
  onChange: (next: string[]) => void;
}

export default function MultiSelectQuestion({
  question,
  selected,
  onChange,
}: Props) {
  const [showMaxWarning, setShowMaxWarning] = useState(false);

  function toggle(option: string) {
    const isSelected = selected.includes(option);
    if (isSelected) {
      setShowMaxWarning(false);
      onChange(selected.filter((item) => item !== option));
      return;
    }
    if (selected.length >= question.maxSelections) {
      setShowMaxWarning(true);
      return;
    }
    setShowMaxWarning(false);
    onChange([...selected, option]);
  }

  return (
    <div>
      <div className="flex flex-col gap-2">
        {question.options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              onClick={() => toggle(option)}
              aria-pressed={isSelected}
              className={[
                "flex w-full items-center justify-between gap-2 rounded-lg border px-3.5 py-3 text-left text-sm transition",
                isSelected
                  ? "border-sage bg-sage/10 text-sage-dark"
                  : "border-greige bg-white text-stone-600 hover:border-sage",
              ].join(" ")}
            >
              <span>{option}</span>
              <span
                className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
                  isSelected
                    ? "border-sage bg-sage text-white"
                    : "border-greige bg-white",
                ].join(" ")}
              >
                {isSelected && (
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-2.5 w-2.5"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {showMaxWarning && (
        <p className="mt-2 text-xs text-earth">
          最大{question.maxSelections}つまで選択できます
        </p>
      )}
    </div>
  );
}
