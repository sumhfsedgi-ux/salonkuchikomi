"use client";

import { useState } from "react";
import type { SurveyQuestion, SurveyAnswers } from "@/lib/types";
import QuestionCard from "@/components/review/QuestionCard";
import { OTHER_OPTION_TEXT } from "@/lib/constants";

interface Props {
  questions: SurveyQuestion[];
  answers: SurveyAnswers;
  onAnswersChange: (answers: SurveyAnswers) => void;
  otherDetails: Record<string, string>;
  onOtherDetailsChange: (details: Record<string, string>) => void;
  onSubmit: (answers: SurveyAnswers) => void;
  loading: boolean;
  hideCta: boolean;
}

export default function SurveyForm({
  questions,
  answers,
  onAnswersChange,
  otherDetails,
  onOtherDetailsChange,
  onSubmit,
  loading,
  hideCta,
}: Props) {
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  function handleChange(id: string, value: string[] | string) {
    onAnswersChange({ ...answers, [id]: value });
  }

  function handleOtherDetailChange(id: string, text: string) {
    onOtherDetailsChange({ ...otherDetails, [id]: text });
  }

  function handleSubmit() {
    if (loading) return;
    const nextErrors: Record<string, string> = {};
    for (const question of questions) {
      const value = answers[question.id];
      if (question.required) {
        const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
        if (isEmpty) {
          nextErrors[question.id] = "この項目を選択してください";
          continue;
        }
      }
      // "その他" は必須/任意の質問を問わず、選んだ以上は具体的な内容の入力を必須にする。
      const selectsOther =
        question.type !== "text" &&
        (Array.isArray(value) ? value.includes(OTHER_OPTION_TEXT) : value === OTHER_OPTION_TEXT);
      if (selectsOther && !otherDetails[question.id]?.trim()) {
        nextErrors[question.id] = "「その他」の具体的な内容を入力してください";
      }
    }
    setValidationErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      const firstInvalid = questions.find((q) => nextErrors[q.id]);
      if (firstInvalid) {
        document
          .querySelector(`[data-question-id="${firstInvalid.id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    onSubmit(answers);
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {questions.map((question, index) => (
          <QuestionCard
            key={question.id}
            question={question}
            index={index}
            value={answers[question.id]}
            onChange={(value) => handleChange(question.id, value)}
            otherDetail={otherDetails[question.id] ?? ""}
            onOtherDetailChange={(text) => handleOtherDetailChange(question.id, text)}
            errorMessage={validationErrors[question.id]}
          />
        ))}
      </div>

      <div
        className={[
          "fixed inset-x-0 bottom-0 border-t border-greige bg-ivory/95 backdrop-blur transition-transform duration-150",
          hideCta ? "translate-y-full" : "translate-y-0",
        ].join(" ")}
      >
        <div
          className="mx-auto w-full max-w-[500px] px-4 pt-3"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            className="btn-primary"
            onClick={handleSubmit}
            disabled={loading}
          >
            アンケートに回答する
          </button>
          <p className="mt-1.5 text-center text-[11px] text-stone-400">
            ※この操作でGoogleに投稿されることはありません
          </p>
        </div>
      </div>
    </>
  );
}
