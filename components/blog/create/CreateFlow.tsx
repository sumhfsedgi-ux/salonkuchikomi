"use client";

import { useState, useEffect } from "react";
import StepIndicator from "@/components/blog/create/StepIndicator";
import ThemeChooser from "@/components/blog/create/ThemeChooser";
import LengthControl from "@/components/blog/create/LengthControl";
import GenerateLoading from "@/components/blog/create/GenerateLoading";
import ResultCard from "@/components/blog/create/ResultCard";
import AdjustMenu from "@/components/blog/create/AdjustMenu";
import DoneStep from "@/components/blog/create/DoneStep";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Toast from "@/components/Toast";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { saveDraftContentAction } from "@/app/dashboard/blog/actions";
import { GENERIC_GENERATION_ERROR } from "@/lib/blog/config/blogRules";
import type { ThemeInput, LengthInput, AdjustMode } from "@/lib/blog/types";

interface Draft {
  title: string;
  body: string;
}

interface GenerateApiResponse {
  postId: string;
  title: string;
  body: string;
}

export default function CreateFlow() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [postId, setPostId] = useState<string | null>(null);
  const [themeInput, setThemeInput] = useState<ThemeInput>({ mode: "omakase" });
  const [lengthInput, setLengthInput] = useState<LengthInput>({ type: "standard" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingVariant, setLoadingVariant] = useState<"create" | "adjust">("create");
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  async function callGenerate(body: unknown): Promise<GenerateApiResponse> {
    const res = await fetch("/api/blog/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(json?.error ?? GENERIC_GENERATION_ERROR);
    }
    return json as GenerateApiResponse;
  }

  async function handleCreate() {
    if (loading) return;
    setLoading(true);
    setLoadingVariant("create");
    setError(null);
    try {
      const result = await callGenerate({ mode: "create", theme: themeInput, length: lengthInput });
      setPostId(result.postId);
      setDraft({ title: result.title, body: result.body });
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_GENERATION_ERROR);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdjust(mode: AdjustMode) {
    if (loading || !postId || !draft) return;
    setLoading(true);
    setLoadingVariant(mode === "regenerate" ? "create" : "adjust");
    setError(null);
    try {
      const body =
        mode === "regenerate"
          ? { mode: "regenerate" as const, postId, theme: themeInput, length: lengthInput }
          : { mode, postId, currentTitle: draft.title, currentBody: draft.body };
      const result = await callGenerate(body);
      setDraft({ title: result.title, body: result.body });
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_GENERATION_ERROR);
    } finally {
      setLoading(false);
    }
  }

  // STEP2でのタイトル・本文の手直しは、それまでローカルstateにしか無く、
  // 「コピー」を押すまでページ更新で消えてしまっていた。編集が落ち着いてから
  // 少し待って自動保存することで、ブラウザ更新等での書き直しロスを防ぐ。
  useEffect(() => {
    if (step !== 2 || !draft || !postId) return;
    const timer = setTimeout(() => {
      saveDraftContentAction(postId, draft.title, draft.body).catch((err) => {
        console.error("auto-save failed", err);
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [draft, postId, step]);

  async function handleCopyTitle() {
    if (!draft) return;
    const ok = await copyToClipboard(draft.title);
    setToastMessage(ok ? "コピーしました" : "コピーできませんでした");
  }

  async function handleCopyBody() {
    if (!draft) return;
    const ok = await copyToClipboard(draft.body);
    setToastMessage(ok ? "コピーしました" : "コピーできませんでした");
  }

  async function handleCopyAll() {
    if (!draft || !postId) return;
    const ok = await copyToClipboard(`${draft.title}\n\n${draft.body}`);
    if (!ok) {
      setToastMessage("コピーできませんでした");
      return;
    }
    setToastMessage("コピーしました");
    setStep(3);
    saveDraftContentAction(postId, draft.title, draft.body).catch((err) => {
      console.error("saveDraftContentAction failed", err);
    });
  }

  function handleReset() {
    setStep(1);
    setPostId(null);
    setDraft(null);
    setThemeInput({ mode: "omakase" });
    setLengthInput({ type: "standard" });
    setError(null);
  }

  return (
    <div className="max-w-xl">
      <StepIndicator step={step} />

      {loading ? (
        <GenerateLoading variant={loadingVariant} />
      ) : step === 1 ? (
        <div className="flex flex-col gap-5">
          <div>
            <h2 className="text-base font-semibold text-ink">今日のブログを作る</h2>
            <p className="mt-1 text-sm text-ink-muted">サロンに合ったテーマからブログを作成します。</p>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-ink-muted">テーマ</p>
              <ThemeChooser value={themeInput} onChange={setThemeInput} />
            </div>

            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-ink-muted">文字量</p>
              <LengthControl value={lengthInput} onChange={setLengthInput} />
            </div>
          </div>

          {error && (
            <Alert variant="error">
              <p>{error}</p>
              <button
                type="button"
                onClick={handleCreate}
                className="mt-2 text-sm underline underline-offset-2"
              >
                もう一度試す
              </button>
            </Alert>
          )}

          <div>
            <p className="mb-2 text-center text-xs text-ink-muted">
              テーマ・文字量はそのままで大丈夫です
            </p>
            <Button type="button" onClick={handleCreate} fullWidth>
              おまかせでブログを作る
            </Button>
          </div>
        </div>
      ) : step === 2 && draft ? (
        <div className="flex flex-col gap-4">
          <ResultCard
            title={draft.title}
            body={draft.body}
            onTitleChange={(title) => setDraft((d) => (d ? { ...d, title } : d))}
            onBodyChange={(body) => setDraft((d) => (d ? { ...d, body } : d))}
            onCopyTitle={handleCopyTitle}
            onCopyBody={handleCopyBody}
            onCopyAll={handleCopyAll}
          />
          {error && <Alert variant="error">{error}</Alert>}
          <AdjustMenu onAdjust={handleAdjust} />
        </div>
      ) : (
        <DoneStep onReset={handleReset} />
      )}

      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
    </div>
  );
}
