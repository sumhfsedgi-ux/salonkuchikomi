"use client";

import { useEffect, useRef, useState } from "react";
import type { SurveyQuestion, SurveyAnswers } from "@/lib/types";
import ReviewHeader from "@/components/review/ReviewHeader";
import type { ReviewStep } from "@/components/review/StepIndicator";
import SurveyForm from "@/components/review/SurveyForm";
import ResultSkeleton from "@/components/review/ResultSkeleton";
import GeneratedReview from "@/components/review/GeneratedReview";
import Toast from "@/components/Toast";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { buildGenerateRequestBody } from "@/lib/reviewGeneration/requestBody";
import type { PreviousStyleSeed } from "@/lib/reviewGeneration/plan";

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
  // STEP 1 = 説明とアンケート、STEP 2 = 口コミの文章案。STEP 2 から STEP 1 へ戻る導線は置かない。
  const [step, setStep] = useState<ReviewStep>(1);
  const [answers, setAnswers] = useState<SurveyAnswers>(() =>
    buildEmptyAnswers(questions),
  );
  // Kept separate from `answers` so the "その他" pill's selected/unselected
  // state (which matches by literal string against question.options) never
  // has to deal with the elaboration text mutating that string. Only merged
  // into the outgoing payload below, right before it's sent to the API.
  const [otherDetails, setOtherDetails] = useState<Record<string, string>>({});
  const [generatedReview, setGeneratedReview] = useState("");
  // v2 の再生成で「前回と違う構成」を選ぶための前回のプラン(素材の本文は含まない)。
  const [previousPlan, setPreviousPlan] = useState<PreviousStyleSeed | null>(null);
  // CTA のクリックを記録するための ID(本文は送らない)。
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [resultVersion, setResultVersion] = useState(0);
  // Hides the sticky bottom CTA while a text field is focused, so it doesn't
  // sit on top of the on-screen keyboard on mobile.
  const [isTextFieldFocused, setIsTextFieldFocused] = useState(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 計測: ボタンを押してから、完成文(または失敗の表示)が画面に反映されるまで。
  // ブラウザの performance に残すだけで、送信もログもしない(開発者ツールや手元の計測で読む)。
  const pendingTimingRef = useRef<{ kind: "initial" | "regenerate"; outcome: "shown" | "failed" } | null>(null);
  const [timingTick, setTimingTick] = useState(0);

  useEffect(() => {
    const timing = pendingTimingRef.current;
    if (!timing) return;
    pendingTimingRef.current = null;
    // 結果を描画したあとのフレームの、さらに次のフレームを終点にする(画面に反映されたあと)。
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        try {
          performance.mark("review:end");
          performance.measure(`review:${timing.kind}:${timing.outcome}`, "review:start", "review:end");
        } catch {
          // 計測できなくても何もしない。
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [timingTick]);

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

  // 回答のチェックが通ったら、すぐ STEP 2 に切り替えて、作っている間の表示を出す。
  function handleSurveySubmit(currentAnswers: SurveyAnswers) {
    setStep(2);
    window.scrollTo({ top: 0 });
    void handleGenerate(currentAnswers);
  }

  async function handleGenerate(currentAnswers: SurveyAnswers) {
    if (loading) return;
    const timingKind = generatedReview ? "regenerate" : "initial";
    const markDone = (outcome: "shown" | "failed") => {
      pendingTimingRef.current = { kind: timingKind, outcome };
      setTimingTick((t) => t + 1);
    };
    try {
      performance.clearMarks("review:start");
      performance.mark("review:start");
    } catch {
      // 計測できなくても何もしない。
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildGenerateRequestBody({
            salonId: salon.id,
            questions,
            answers: currentAnswers,
            otherDetails,
            previousReview: generatedReview,
            previousPlan,
          }),
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "口コミの作成に失敗しました。もう一度お試しください。");
        markDone("failed");
        return;
      }
      setGeneratedReview(data.review);
      setPreviousPlan(data.plan ?? null);
      setGenerationId(typeof data.generationId === "string" ? data.generationId : null);
      setResultVersion((v) => v + 1);
      markDone("shown");
    } catch {
      setError(
        "通信エラーが発生しました。ネットワークをご確認のうえ、もう一度お試しください。",
      );
      markDone("failed");
    } finally {
      setLoading(false);
    }
  }

  // Reads `generatedReview` fresh on every render, so this always copies
  // whatever is currently in the (editable) textarea -- including any edits
  // the customer made after generation -- never the original AI output.
  // Deliberately never blocks navigation on the result: the "この口コミをコピーして
  // Googleレビューへ進む" link's default action (opening googleReviewUrl) always proceeds
  // regardless of whether the copy succeeds, so a Clipboard API failure
  // never strands the customer -- they can still select and copy the
  // textarea manually once they land on Google's page.
  async function handleCopy() {
    recordCtaClick();
    const ok = await copyToClipboard(generatedReview);
    setToastMessage(ok ? "コピーしました" : "コピーできませんでした。テキストを選択してコピーしてください");
  }

  // 記録は失敗しても構わない(Google の投稿画面へ進むのを妨げない)。sendBeacon は
  // ページを離れても送られる。使えないブラウザでは keepalive の fetch で送る。
  function recordCtaClick() {
    if (!generationId) return;
    const payload = JSON.stringify({ generationId, salonId: salon.id });
    try {
      const sent = navigator.sendBeacon?.("/api/review-events", new Blob([payload], { type: "application/json" }));
      if (!sent) {
        void fetch("/api/review-events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      // 記録できなくても何もしない。
    }
  }

  // STEP 1 だけ、画面の下に固定したボタン(と注意書き)の分の余白を空ける。
  return (
    <>
      <ReviewHeader salonName={salon.name} step={step} />
      <div
        className="mx-auto flex w-full max-w-[500px] flex-1 flex-col px-4"
        style={step === 1 ? { paddingBottom: "calc(7.5rem + env(safe-area-inset-bottom))" } : undefined}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
      >
        {step === 1 ? (
          <div className="pt-4">
            <SurveyForm
              questions={questions}
              answers={answers}
              onAnswersChange={setAnswers}
              otherDetails={otherDetails}
              onOtherDetailsChange={setOtherDetails}
              onSubmit={handleSurveySubmit}
              loading={loading}
              hideCta={isTextFieldFocused}
            />
          </div>
        ) : (
          <section className="flex flex-col gap-3 pt-5">
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
            {/* 1回目の作成に失敗したときは文章案が無いので、ここで作り直せるようにする。 */}
            {!loading && error && !generatedReview && (
              <button
                type="button"
                onClick={() => void handleGenerate(answers)}
                className="btn-primary"
              >
                もう一度作成する
              </button>
            )}
            {generatedReview && (
              <GeneratedReview
                key={resultVersion}
                review={generatedReview}
                onReviewChange={setGeneratedReview}
                onCopy={handleCopy}
                onRegenerate={() => void handleGenerate(answers)}
                googleReviewUrl={salon.googleReviewUrl}
                disabled={loading}
              />
            )}
          </section>
        )}

        <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
      </div>
    </>
  );
}
