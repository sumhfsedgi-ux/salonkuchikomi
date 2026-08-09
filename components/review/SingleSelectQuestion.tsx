"use client";

import type { SingleSelectQuestion as SingleSelectQuestionType } from "@/lib/types";

interface Props {
  question: SingleSelectQuestionType;
  selected: string;
  onChange: (next: string) => void;
}

export default function SingleSelectQuestion({
  question,
  selected,
  onChange,
}: Props) {
  return (
    <div className="flex flex-col gap-2">
      {question.options.map((option) => {
        const isSelected = selected === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => {
              if (!isSelected) onChange(option);
            }}
            aria-pressed={isSelected}
            className={[
              "flex w-full items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-left text-sm transition",
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
  );
}
