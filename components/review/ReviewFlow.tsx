"use client";

import { useState } from "react";
import type { SurveyQuestion, SurveyAnswers } from "@/lib/types";
import Hero from "@/components/review/Hero";
import ReviewStepper from "@/components/review/ReviewStepper";
import SurveyForm from "@/components/review/SurveyForm";
import ReviewLoading from "@/components/review/ReviewLoading";
import GeneratedReview from "@/components/review/GeneratedReview";
import GoogleReviewGuide from "@/components/review/GoogleReviewGuide";
import Toast from "@/components/Toast";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { OTHER_OPTION_TEXT } from "@/lib/constants";

type Step = 1 | 2 | 3;

interface Props {
  salon: { id: string; name: string; googleReviewUrl: string };
  questions: SurveyQuestion[];
}

function buildEmptyAnswers(questions: SurveyQuestion[]): SurveyAnswers {
  const answers: SurveyAnswers = {};
  for (const question of questions) {
    answers[question.id] = question.type === "multiple" ? [] : "";
  }
  return answers;
}

export default function ReviewFlow({ salon, questions }: Props) {
  const [answers, setAnswers] = useState<SurveyAnswers>(() =>
    buildEmptyAnswers(questions),
  );
  // Kept separate from `answers` so the "その他" pill's selected/unselected
  // state (which matches by literal string against question.options) never
  // has to deal with the elaboration text mutating that string. Only merged
  // into the outgoing payload below, right before it's sent to the API.
  const [otherDetails, setOtherDetails] = useState<Record<string, string>>({});
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [generatedReview, setGeneratedReview] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  async function handleGenerate(currentAnswers: SurveyAnswers) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salonId: salon.id,
          answers: questions.map((question) => {
            const raw = currentAnswers[question.id];
            const detail = otherDetails[question.id]?.trim();
            const withDetail = (value: string) =>
              value === OTHER_OPTION_TEXT && detail
                ? `${OTHER_OPTION_TEXT}（${detail}）`
                : value;
            const answer = Array.isArray(raw) ? raw.map(withDetail) : withDetail(raw);
            return { question: question.question, answer };
          }),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "口コミの作成に失敗しました。もう一度お試しください。");
        return;
      }
      setGeneratedReview(data.review);
      setCurrentStep(2);
    } catch {
      setError(
        "通信エラーが発生しました。ネットワークをご確認のうえ、もう一度お試しください。",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    const ok = await copyToClipboard(generatedReview);
    if (!ok) {
      setToastMessage("コピーできませんでした");
      return;
    }
    setToastMessage("コピーしました");
    setCurrentStep(3);
  }

  return (
    <div className="mx-auto flex w-full max-w-[500px] flex-1 flex-col px-4">
      {currentStep === 1 && <Hero salonName={salon.name} />}
      <ReviewStepper currentStep={currentStep} />

      {/*
        While loading is true, ReviewLoading fully replaces the step content below,
        which un-mounts the submit/regenerate buttons and prevents double submission.
      */}
      {loading ? (
        <ReviewLoading />
      ) : (
        <>
          {currentStep === 1 && (
            <SurveyForm
              questions={questions}
              answers={answers}
              onAnswersChange={setAnswers}
              otherDetails={otherDetails}
              onOtherDetailsChange={setOtherDetails}
              onSubmit={handleGenerate}
              error={error}
            />
          )}
          {currentStep === 2 && (
            <GeneratedReview
              review={generatedReview}
              onReviewChange={setGeneratedReview}
              onCopy={handleCopy}
              onRegenerate={() => handleGenerate(answers)}
              onEditSurvey={() => setCurrentStep(1)}
              error={error}
            />
          )}
          {currentStep === 3 && (
            <GoogleReviewGuide googleReviewUrl={salon.googleReviewUrl} />
          )}
        </>
      )}

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </div>
  );
}
