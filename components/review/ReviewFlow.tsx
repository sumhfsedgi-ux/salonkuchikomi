"use client";

import { useEffect, useRef, useState } from "react";
import type { SurveyQuestion, SurveyAnswers } from "@/lib/types";
import Hero from "@/components/review/Hero";
import SurveyForm from "@/components/review/SurveyForm";
import ResultSkeleton from "@/components/review/ResultSkeleton";
import GeneratedReview from "@/components/review/GeneratedReview";
import Toast from "@/components/Toast";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { OTHER_OPTION_TEXT } from "@/lib/constants";

interface Props {
  salon: { id: string; name: string; googleReviewUrl: string; businessType: string | null };
  questions: SurveyQuestion[];
}

function buildEmptyAnswers(questions: SurveyQuestion[]): SurveyAnswers {
  const answers: SurveyAnswers = {};
  for (const question of questions) {
    answers[question.id] = question.type === "multiple" ? [] : "";
  }
  return answers;
}

function isTextField(target: EventTarget): target is HTMLTextAreaElement | HTMLInputElement {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
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
  const [generatedReview, setGeneratedReview] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [resultVersion, setResultVersion] = useState(0);
  // Hides the sticky bottom CTA while a text field is focused, so it doesn't
  // sit on top of the on-screen keyboard on mobile.
  const [isTextFieldFocused, setIsTextFieldFocused] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (loading) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loading]);

  function handleFocusCapture(e: React.FocusEvent) {
    if (!isTextField(e.target)) return;
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    setIsTextFieldFocused(true);
  }

  function handleBlurCapture(e: React.FocusEvent) {
    if (!isTextField(e.target)) return;
    // Short grace period so moving focus from one textarea straight to
    // another in the same form doesn't flash the CTA back in between.
    blurTimeoutRef.current = setTimeout(() => setIsTextFieldFocused(false), 50);
  }

  async function handleGenerate(currentAnswers: SurveyAnswers) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salonId: salon.id,
          salonName: salon.name,
          businessType: salon.businessType ?? undefined,
          previousReview: generatedReview || undefined,
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
      setResultVersion((v) => v + 1);
    } catch {
      setError(
        "通信エラーが発生しました。ネットワークをご確認のうえ、もう一度お試しください。",
      );
    } finally {
      setLoading(false);
    }
  }

  // Reads `generatedReview` fresh on every render, so this always copies
  // whatever is currently in the (editable) textarea -- including any edits
  // the customer made after generation -- never the original AI output.
  // Deliberately never blocks navigation on the result: the "Google口コミを
  // 書く" link's default action (opening googleReviewUrl) always proceeds
  // regardless of whether the copy succeeds, so a Clipboard API failure
  // never strands the customer -- they can still select and copy the
  // textarea manually once they land on Google's page.
  async function handleCopy() {
    const ok = await copyToClipboard(generatedReview);
    setToastMessage(ok ? "コピーしました" : "コピーできませんでした。テキストを選択してコピーしてください");
  }

  const showResult = loading || generatedReview !== "" || error !== null;

  return (
    <div
      className="mx-auto flex w-full max-w-[500px] flex-1 flex-col px-4"
      style={{ paddingBottom: "calc(6rem + env(safe-area-inset-bottom))" }}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      <Hero salonName={salon.name} />

      <div className="flex flex-col gap-4">
        <SurveyForm
          questions={questions}
          answers={answers}
          onAnswersChange={setAnswers}
          otherDetails={otherDetails}
          onOtherDetailsChange={setOtherDetails}
          onSubmit={handleGenerate}
          loading={loading}
          hasResult={generatedReview !== ""}
          hideCta={isTextFieldFocused}
        />

        {showResult && (
          <section ref={resultRef} className="flex flex-col gap-3 scroll-mt-4">
            {loading && !generatedReview && <ResultSkeleton />}
            {loading && generatedReview && (
              <div className="flex items-center gap-2 rounded-lg bg-beige/60 px-3 py-2 text-sm text-stone-600">
                <span
                  className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-greige border-t-sage"
                  aria-hidden="true"
                />
                新しい口コミを作成しています…
              </div>
            )}
            {!loading && error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            )}
            {generatedReview && (
              <GeneratedReview
                key={resultVersion}
                review={generatedReview}
                onReviewChange={setGeneratedReview}
                onCopy={handleCopy}
                googleReviewUrl={salon.googleReviewUrl}
                disabled={loading}
              />
            )}
          </section>
        )}
      </div>

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </div>
  );
}
