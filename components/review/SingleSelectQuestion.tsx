"use client";

import { Fragment } from "react";
import type { SingleSelectQuestion as SingleSelectQuestionType } from "@/lib/types";
import { OTHER_DETAIL_MAX_LENGTH, OTHER_OPTION_TEXT } from "@/lib/constants";

interface Props {
  question: SingleSelectQuestionType;
  selected: string;
  onChange: (next: string) => void;
  otherDetail: string;
  onOtherDetailChange: (text: string) => void;
}

export default function SingleSelectQuestion({
  question,
  selected,
  onChange,
  otherDetail,
  onOtherDetailChange,
}: Props) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {question.options.map((option) => {
        const isSelected = selected === option;
        return (
          <Fragment key={option}>
            <button
              type="button"
              onClick={() => {
                if (!isSelected) onChange(option);
              }}
              aria-pressed={isSelected}
              className={[
                "relative flex min-h-13 w-full items-center justify-center rounded-xl border px-2 py-3 text-center text-sm leading-snug transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 focus-visible:ring-offset-1",
                isSelected
                  ? "border-sage bg-sage/10 text-sage-dark"
                  : "border-greige bg-white text-stone-600 hover:border-sage",
              ].join(" ")}
            >
              <span>{option}</span>
              {isSelected && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-sage text-white">
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
                </span>
              )}
            </button>
            {isSelected && option === OTHER_OPTION_TEXT && (
              <textarea
                value={otherDetail}
                onChange={(e) =>
                  onOtherDetailChange(e.target.value.slice(0, OTHER_DETAIL_MAX_LENGTH))
                }
                placeholder="具体的に教えてください"
                rows={2}
                className="col-span-2 w-full resize-none rounded-lg border border-greige bg-white p-3 text-sm text-stone-700 placeholder:text-stone-400 transition focus:border-sage focus:outline-none"
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
