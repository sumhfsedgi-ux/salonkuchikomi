"use client";

import { useState } from "react";
import { emptySurveyAnswers, type SurveyAnswers } from "@/config/survey";
import Hero from "@/components/Hero";
import ReviewStepper from "@/components/ReviewStepper";
import SurveyForm from "@/components/SurveyForm";
import ReviewLoading from "@/components/ReviewLoading";
import GeneratedReview from "@/components/GeneratedReview";
import GoogleReviewGuide from "@/components/GoogleReviewGuide";
import Toast from "@/components/Toast";

type Step = 1 | 2 | 3;

export default function Home() {
  const [answers, setAnswers] = useState<SurveyAnswers>(emptySurveyAnswers);
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
        body: JSON.stringify(currentAnswers),
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
    await navigator.clipboard.writeText(generatedReview);
    setToastMessage("コピーしました");
    setCurrentStep(3);
  }

  return (
    <div className="mx-auto flex w-full max-w-[500px] flex-1 flex-col px-4">
      {currentStep === 1 && <Hero />}
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
              answers={answers}
              onAnswersChange={setAnswers}
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
          {currentStep === 3 && <GoogleReviewGuide />}
        </>
      )}

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </div>
  );
}
