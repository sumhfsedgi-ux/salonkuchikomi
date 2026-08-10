"use client";

import { useState } from "react";
import type { SurveyQuestion, SurveyAnswers } from "@/lib/types";
import QuestionCard from "@/components/review/QuestionCard";

interface Props {
  questions: SurveyQuestion[];
  answers: SurveyAnswers;
  onAnswersChange: (answers: SurveyAnswers) => void;
  otherDetails: Record<string, string>;
  onOtherDetailsChange: (details: Record<string, string>) => void;
  onSubmit: (answers: SurveyAnswers) => void;
  error: string | null;
}

export default function SurveyForm({
  questions,
  answers,
  onAnswersChange,
  otherDetails,
  onOtherDetailsChange,
  onSubmit,
  error,
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
    const nextErrors: Record<string, string> = {};
    for (const question of questions) {
      if (!question.required) continue;
      const value = answers[question.id];
      const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
      if (isEmpty) {
        nextErrors[question.id] = "この項目を選択してください";
      }
    }
    setValidationErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSubmit(answers);
  }

  return (
    <div className="flex flex-col gap-4 pb-8">
      {questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          question={question}
          index={index}
          total={questions.length}
          value={answers[question.id]}
          onChange={(value) => handleChange(question.id, value)}
          otherDetail={otherDetails[question.id] ?? ""}
          onOtherDetailChange={(text) => handleOtherDetailChange(question.id, text)}
          errorMessage={validationErrors[question.id]}
        />
      ))}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <button type="button" className="btn-primary" onClick={handleSubmit}>
        AIで口コミを作成する
      </button>
    </div>
  );
}
