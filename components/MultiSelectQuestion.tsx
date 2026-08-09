"use client";

import { useState } from "react";
import type { MultiSelectQuestion as MultiSelectQuestionType } from "@/config/survey";

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
      <div className="flex flex-wrap gap-2">
        {question.options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              onClick={() => toggle(option)}
              aria-pressed={isSelected}
              className={[
                "rounded-full border px-3.5 py-2 text-sm transition",
                isSelected
                  ? "border-sage bg-sage text-white"
                  : "border-greige bg-white text-stone-600 hover:border-sage",
              ].join(" ")}
            >
              {option}
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
