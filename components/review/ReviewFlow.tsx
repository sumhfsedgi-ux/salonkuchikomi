"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { preload } from "react-dom";
import type { SurveyQuestion, SurveyAnswers } from "@/lib/types";
import ReviewHeader from "@/components/review/ReviewHeader";
import SurveyForm from "@/components/review/SurveyForm";
import ResultSkeleton from "@/components/review/ResultSkeleton";
import GenerationShowcase from "@/components/review/GenerationShowcase";
import GeneratedReview from "@/components/review/GeneratedReview";
import PostingGuide from "@/components/review/PostingGuide";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { buildGenerateRequestBody } from "@/lib/reviewGeneration/requestBody";
import type { PreviousStyleSeed } from "@/lib/reviewGeneration/plan";
import type { PublicShowcase } from "@/lib/reviewShowcase/settings";
import { INITIAL_FLOW_STATE, flowReducer, generatingView } from "@/lib/reviewFlow/flowState";

interface Props {
  salon: { id: string; name: string; googleReviewUrl: string; businessType: string | null };
  questions: SurveyQuestion[];
  /** 口コミ作成中の表示(店舗が設定して有効なときだけ。0033)。口コミの生成には使わない。 */
  showcase?: PublicShowcase | null;
}

type ClientEventKind = "review_copied" | "google_opened";

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

export default function ReviewFlow({ salon, questions, showcase = null }: Props) {
  // STEP 1 回答 → STEP 2 文章の確認 → STEP 3 投稿のご案内(lib/reviewFlow/flowState.ts)。
  // STEP 2 から STEP 1 へ戻る導線は置かない。STEP 3 からは「文章を編集する」で STEP 2 に戻れる。
  const [state, dispatch] = useReducer(flowReducer, INITIAL_FLOW_STATE);
  const { step, review: generatedReview, generating: loading, error } = state;
  const [answers, setAnswers] = useState<SurveyAnswers>(() =>
    buildEmptyAnswers(questions),
  );
  // Kept separate from `answers` so the "その他" pill's selected/unselected
  // state (which matches by literal string against question.options) never
  // has to deal with the elaboration text mutating that string. Only merged
  // into the outgoing payload below, right before it's sent to the API.
  const [otherDetails, setOtherDetails] = useState<Record<string, string>>({});
  // v2 の再生成で「前回と違う構成」を選ぶための前回のプラン(素材の本文は含まない)。
  const [previousPlan, setPreviousPlan] = useState<PreviousStyleSeed | null>(null);
  // 操作(コピー・Google の投稿画面を開く)を記録するための ID(本文は送らない)。
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [resultVersion, setResultVersion] = useState(0);
  // Hides the sticky bottom CTA while a text field is focused, so it doesn't
  // sit on top of the on-screen keyboard on mobile.
  const [isTextFieldFocused, setIsTextFieldFocused] = useState(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 二重の送信を止める(state の generating は次の描画まで反映されないため)。
  const inFlightRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 計測: ボタンを押してから、完成文(または失敗の表示)が画面に反映されるまで。
  // ブラウザの performance に残すだけで、送信もログもしない(開発者ツールや手元の計測で読む)。
  const pendingTimingRef = useRef<{ kind: "initial" | "regenerate"; outcome: "shown" | "failed" } | null>(null);
  const [timingTick, setTimingTick] = useState(0);

  // 作成中の表示の写真は、アンケートに答えている間に読み込んでおく(作成を始めたときに写真の読み込みで待たせない)。
  // 優先度は低くして、アンケートの画面の表示を遅らせない。
  const showcaseImageUrl = showcase?.imageUrl ?? null;
  if (showcaseImageUrl) preload(showcaseImageUrl, { as: "image", fetchPriority: "low" });
  useEffect(() => {
    if (!showcaseImageUrl) return;
    const img = new Image();
    img.decoding = "async";
    img.src = showcaseImageUrl;
  }, [showcaseImageUrl]);

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
    dispatch({ type: "survey_submitted" });
    window.scrollTo({ top: 0 });
    void handleGenerate(currentAnswers);
  }

  async function handleGenerate(currentAnswers: SurveyAnswers) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
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
    dispatch({ type: "generate_started" });
    try {
      // 生成に送るのはお客様の回答だけ(作成中の表示の写真・コピーは送らない)。
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
        dispatch({ type: "generate_failed", error: data.error ?? "口コミの作成に失敗しました。もう一度お試しください。" });
        markDone("failed");
        return;
      }
      dispatch({ type: "generate_succeeded", review: data.review });
      setPreviousPlan(data.plan ?? null);
      setGenerationId(typeof data.generationId === "string" ? data.generationId : null);
      setResultVersion((v) => v + 1);
      markDone("shown");
    } catch {
      dispatch({
        type: "generate_failed",
        error: "通信エラーが発生しました。ネットワークをご確認のうえ、もう一度お試しください。",
      });
      markDone("failed");
    } finally {
      inFlightRef.current = false;
    }
  }

  // その時点の文章(お客様が編集したあとの最新)をコピーする。コピーできたときだけ投稿のご案内へ進み、
  // できなかったときは文章を残したまま、もう一度のコピーと手動でのコピーを案内する(「コピーしました」は出さない)。
  async function handleCopyAndContinue() {
    if (loading || !generatedReview) return;
    const ok = await copyToClipboard(generatedReview);
    if (ok) {
      dispatch({ type: "copy_succeeded" });
      recordEvent("review_copied");
      window.scrollTo({ top: 0 });
      return;
    }
    dispatch({ type: "copy_failed" });
    // 手動でコピーしやすいように、文章を選んだ状態にする。
    requestAnimationFrame(() => textareaRef.current?.select());
  }

  function handleManualContinue() {
    dispatch({ type: "manual_copy_confirmed" });
    window.scrollTo({ top: 0 });
  }

  function handleBackToEdit() {
    dispatch({ type: "back_to_edit" });
    window.scrollTo({ top: 0 });
  }

  // 記録は失敗しても構わない(Google の投稿画面へ進むのを妨げない)。sendBeacon は
  // ページを離れても送られる。使えないブラウザでは keepalive の fetch で送る。
  function recordEvent(kind: ClientEventKind) {
    if (!generationId) return;
    const payload = JSON.stringify({ generationId, salonId: salon.id, kind });
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

  const view = generatingView(state, showcase !== null);
  // 読み上げ向けの、作成中・作成の完了の案内(エラーは role="alert" で別に伝える)。
  const statusText = loading ? "口コミの文章を作成しています" : step === 2 && generatedReview && !error ? "口コミの文章を作成しました" : "";

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
        <p className="sr-only" role="status" aria-live="polite">
          {statusText}
        </p>
        {step === 1 && (
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
        )}
        {step === 2 && (
          <section className="flex flex-col gap-3 pt-5">
            {view === "showcase" && showcase && <GenerationShowcase showcase={showcase} salonName={salon.name} />}
            {view === "skeleton" && <ResultSkeleton />}
            {view === "inline" && (
              <div className="flex items-center gap-2 rounded-lg bg-beige/60 px-3 py-2 text-sm text-stone-600">
                <span
                  className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-greige border-t-sage"
                  aria-hidden="true"
                />
                新しい口コミを作成しています…
              </div>
            )}
            {!loading && error && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
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
                onReviewChange={(next) => dispatch({ type: "review_edited", review: next })}
                onCopy={() => void handleCopyAndContinue()}
                onRegenerate={() => void handleGenerate(answers)}
                googleReviewUrl={salon.googleReviewUrl}
                disabled={loading}
                copyFailed={state.copyFailed}
                onManualContinue={handleManualContinue}
                textareaRef={textareaRef}
              />
            )}
          </section>
        )}
        {step === 3 && (
          <section className="flex flex-col gap-3 pt-5">
            <PostingGuide
              copied={state.copied}
              googleReviewUrl={salon.googleReviewUrl}
              onOpenGoogle={() => recordEvent("google_opened")}
              onBack={handleBackToEdit}
            />
          </section>
        )}
      </div>
    </>
  );
}
