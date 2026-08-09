"use client";

import { useState } from "react";
import QuestionCardEditor from "@/components/admin/QuestionCardEditor";
import { addQuestionAction } from "@/app/admin/(authed)/survey/actions";

interface OptionData {
  id: string;
  option_text: string;
}

interface QuestionData {
  id: string;
  question_text: string;
  question_type: "single" | "multiple" | "text";
  required: boolean;
  max_selections: number | null;
  options: OptionData[];
}

export default function QuestionEditor({ questions }: { questions: QuestionData[] }) {
  const [adding, setAdding] = useState(false);

  async function handleAddQuestion() {
    setAdding(true);
    const formData = new FormData();
    formData.set("question_text", "新しい質問");
    formData.set("question_type", "multiple");
    formData.set("required", "on");
    formData.set("max_selections", "3");
    await addQuestionAction(formData);
    setAdding(false);
  }

  return (
    <div className="flex flex-col gap-4">
      {questions.map((question, i) => (
        <QuestionCardEditor
          key={question.id}
          question={question}
          isFirst={i === 0}
          isLast={i === questions.length - 1}
        />
      ))}

      <button
        type="button"
        disabled={adding}
        onClick={handleAddQuestion}
        className="rounded-xl border border-dashed border-slate-300 py-4 text-sm font-medium text-slate-500 transition hover:border-slate-400 hover:text-slate-700 disabled:opacity-50"
      >
        {adding ? "追加しています..." : "＋ 質問を追加"}
      </button>
    </div>
  );
}
