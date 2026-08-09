"use client";

import type { TextQuestion } from "@/lib/types";

interface Props {
  question: TextQuestion;
  value: string;
  onChange: (next: string) => void;
}

export default function TextareaQuestion({ question, value, onChange }: Props) {
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, question.maxLength))}
        rows={4}
        className="w-full resize-none rounded-lg border border-greige bg-white p-3 text-sm text-stone-700 placeholder:text-stone-400 focus:border-sage focus:outline-none"
      />
      <p className="mt-1 text-right text-xs text-stone-400">
        {value.length} / {question.maxLength}
      </p>
    </div>
  );
}
