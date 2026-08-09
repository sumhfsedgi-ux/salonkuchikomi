"use client";

import { useState } from "react";
import { surveyQuestions, type SurveyAnswers } from "@/config/survey";
import QuestionCard from "@/components/QuestionCard";

interface Props {
  answers: SurveyAnswers;
  onAnswersChange: (answers: SurveyAnswers) => void;
  onSubmit: (answers: SurveyAnswers) => void;
  error: string | null;
}

export default function SurveyForm({
  answers,
  onAnswersChange,
  onSubmit,
  error,
}: Props) {
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  function handleChange(id: string, value: string[] | string) {
    onAnswersChange({ ...answers, [id]: value } as SurveyAnswers);
  }

  function handleSubmit() {
    const nextErrors: Record<string, string> = {};
    for (const question of surveyQuestions) {
      if (!question.required) continue;
      const value = answers[question.id as keyof SurveyAnswers];
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
      {surveyQuestions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          value={answers[question.id as keyof SurveyAnswers]}
          onChange={(value) => handleChange(question.id, value)}
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
