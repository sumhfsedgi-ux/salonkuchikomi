"use client";

import { useEffect, useId, useRef, useState } from "react";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import PillSelect from "@/components/ui/PillSelect";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import LeaveGuard from "@/components/ui/LeaveGuard";
import GenerationShowcase from "@/components/review/GenerationShowcase";
import ResultSkeleton from "@/components/review/ResultSkeleton";
import {
  CATCH_COPY_MAX_LENGTH,
  CATCH_COPY_RECOMMENDED,
  catchCopyError,
  catchCopyLength,
  enableError,
  normalizeCatchCopy,
  type ShowcaseSettings,
} from "@/lib/reviewShowcase/settings";
import { resizeShowcaseImage } from "@/lib/reviewShowcase/resizeImage";
import type { SaveShowcaseResult } from "@/app/dashboard/reviews/showcaseActions";

// 口コミ作成中の表示(お客様ページで、口コミの文章を作っている間に出す写真とキャッチコピー。0033)。
// 写真・コピー・表示の有効/無効を [保存する] でまとめて保存する。プレビューはお客様ページと同じ部品で出す。

interface Props {
  initialSettings: ShowcaseSettings;
  /** 保存できる状態か(0033 が未適用などで保存できないときは false)。 */
  storageAvailable: boolean;
  salonName: string;
  save: (formData: FormData) => Promise<SaveShowcaseResult>;
}

type ImageState =
  | { kind: "saved"; url: string }
  | { kind: "new"; blob: Blob; previewUrl: string }
  | { kind: "none" };

const ENABLED_OPTIONS = [
  { value: "on" as const, label: "表示する" },
  { value: "off" as const, label: "表示しない" },
];

const PREVIEW_SECONDS = 3;

function imageFromSettings(settings: ShowcaseSettings): ImageState {
  return settings.imageUrl ? { kind: "saved", url: settings.imageUrl } : { kind: "none" };
}

export default function ReviewShowcaseForm({ initialSettings, storageAvailable, salonName, save }: Props) {
  const copyId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [saved, setSaved] = useState<ShowcaseSettings>(initialSettings);
  const [enabled, setEnabled] = useState(initialSettings.enabled);
  const [catchCopy, setCatchCopy] = useState(initialSettings.catchCopy);
  const [image, setImage] = useState<ImageState>(() => imageFromSettings(initialSettings));
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [playing, setPlaying] = useState<"idle" | "showcase" | "done">("idle");

  const imageUrl = image.kind === "saved" ? image.url : image.kind === "new" ? image.previewUrl : null;
  const normalizedCopy = normalizeCatchCopy(catchCopy);
  const copyCount = catchCopyLength(normalizedCopy);
  const imageChanged = image.kind === "new" || (image.kind === "none" && saved.imageUrl !== null);
  const dirty = enabled !== saved.enabled || normalizedCopy !== saved.catchCopy || imageChanged;
  const enableProblem = enabled ? enableError({ hasImage: imageUrl !== null, catchCopy: normalizedCopy }) : null;

  // 選び直した・保存した・画面を離れたときに、プレビュー用の一時的な URL を解放する。
  useEffect(() => {
    if (image.kind !== "new") return;
    return () => URL.revokeObjectURL(image.previewUrl);
  }, [image]);

  // 3秒間の表示の確認: 作成中の表示 → 3秒後に完成した画面の見本。
  useEffect(() => {
    if (playing !== "showcase") return;
    const timer = setTimeout(() => setPlaying("done"), PREVIEW_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [playing]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setStatus(null);
    setProcessing(true);
    try {
      const blob = await resizeShowcaseImage(file);
      if (!blob) {
        setStatus({ type: "error", message: "この写真は読み込めませんでした。JPEG・PNG の写真をお試しください。" });
        return;
      }
      setImage({ kind: "new", blob, previewUrl: URL.createObjectURL(blob) });
    } finally {
      setProcessing(false);
    }
  }

  function handleRemoveImage() {
    setImage({ kind: "none" });
    // 写真が無いと表示できないので、表示も止める(保存するまでは反映されない)。
    setEnabled(false);
    setStatus(null);
  }

  async function handleSave() {
    if (saving || processing || !storageAvailable) return;
    const copyProblem = catchCopyError(normalizedCopy);
    if (copyProblem || enableProblem) {
      setStatus({ type: "error", message: (copyProblem ?? enableProblem)! });
      return;
    }
    setSaving(true);
    setStatus(null);
    const formData = new FormData();
    formData.set("enabled", enabled ? "1" : "0");
    formData.set("catch_copy", normalizedCopy);
    if (image.kind === "new") formData.set("image", new File([image.blob], "showcase.jpg", { type: "image/jpeg" }));
    if (image.kind === "none" && saved.imageUrl) formData.set("remove_image", "1");
    try {
      const result = await save(formData);
      if (result.ok) {
        setSaved(result.settings);
        setEnabled(result.settings.enabled);
        setCatchCopy(result.settings.catchCopy);
        setImage(imageFromSettings(result.settings));
        setStatus({ type: "success", message: "保存しました。" });
      } else {
        setStatus({ type: "error", message: result.error });
      }
    } catch {
      setStatus({ type: "error", message: "保存できませんでした。もう一度お試しください。" });
    } finally {
      setSaving(false);
    }
  }

  const previewShowcase = imageUrl && normalizedCopy ? { imageUrl, catchCopy: normalizedCopy } : null;

  return (
    <div className="flex flex-col gap-4">
      <LeaveGuard
        when={dirty && storageAvailable}
        message="口コミ作成中の表示に、保存していない変更があります。移動すると、変更は保存されません。"
      />
      <div>
        <h3 className="font-medium text-ink">口コミ作成中の表示</h3>
        <p className="mt-1 text-sm text-ink-muted">
          お客様がアンケートに答えたあと、口コミの文章ができるまでの数秒間に、お店の写真とキャッチコピーを表示します。文章ができたら、すぐに次の画面へ進みます。
        </p>
      </div>

      {!storageAvailable && (
        <Alert variant="warning">口コミ作成中の表示の設定は準備中です。いまはシンプルな読み込み中の表示になります。</Alert>
      )}

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div>
            <Label>表示</Label>
            <PillSelect
              options={ENABLED_OPTIONS}
              value={enabled ? "on" : "off"}
              onChange={(v) => {
                setEnabled(v === "on");
                setStatus(null);
              }}
            />
            {enableProblem && <p className="mt-1 text-xs text-danger">{enableProblem}</p>}
            {!enabled && <p className="mt-1 text-xs text-ink-muted">表示しないときは、シンプルな読み込み中の表示になります。</p>}
          </div>

          <div>
            <Label>写真（1枚）</Label>
            <p className="mb-2 text-xs text-ink-muted">
              縦長（4:5）で表示します。スマートフォンでは上下や左右が切れることがあるので、プレビューで確認してください。
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={handleFileChange}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={processing || saving || !storageAvailable}
                onClick={() => fileInputRef.current?.click()}
              >
                {processing ? "写真を読み込んでいます…" : imageUrl ? "写真を変更する" : "写真を選ぶ"}
              </Button>
              {imageUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={processing || saving || !storageAvailable}
                  onClick={handleRemoveImage}
                >
                  写真を削除する
                </Button>
              )}
            </div>
            {image.kind === "none" && saved.imageUrl && (
              <p className="mt-1 text-xs text-ink-muted">保存すると写真を削除し、表示も止めます。</p>
            )}
          </div>

          <div>
            <Label htmlFor={copyId}>キャッチコピー</Label>
            <Input
              id={copyId}
              value={catchCopy}
              maxLength={CATCH_COPY_MAX_LENGTH + 10}
              placeholder="例：忙しい毎日に、自分をいたわる時間を。"
              disabled={!storageAvailable}
              onChange={(e) => {
                setCatchCopy(e.target.value.replace(/[\r\n]/g, ""));
                setStatus(null);
              }}
            />
            <p className="mt-1 flex justify-between gap-2 text-xs text-ink-muted">
              <span>
                目安は{CATCH_COPY_RECOMMENDED.min}〜{CATCH_COPY_RECOMMENDED.max}文字です。写真の上に2行までで表示します。
              </span>
              <span className={copyCount > CATCH_COPY_MAX_LENGTH ? "shrink-0 text-danger" : "shrink-0"}>
                {copyCount}/{CATCH_COPY_MAX_LENGTH}
              </span>
            </p>
            <p className="mt-1 text-xs text-ink-muted">写真とキャッチコピーは、口コミの文章の作成には使いません。</p>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3 lg:w-[320px] lg:shrink-0">
          <p className="self-start text-sm font-medium text-ink lg:self-center">スマートフォンでの表示</p>
          <PhonePreview salonName={salonName} showcase={previewShowcase} playing={playing} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={playing === "showcase"}
            onClick={() => setPlaying("showcase")}
          >
            {playing === "showcase" ? "表示しています…" : `${PREVIEW_SECONDS}秒間の表示を確認する`}
          </Button>
          {playing === "done" && (
            <button
              type="button"
              className="text-xs text-ink-muted underline underline-offset-4"
              onClick={() => setPlaying("idle")}
            >
              プレビューに戻る
            </button>
          )}
        </div>
      </div>

      {status?.type === "error" && <Alert variant="error">{status.message}</Alert>}
      {status?.type === "success" && !dirty && <Alert variant="success">{status.message}</Alert>}

      <Button
        type="button"
        onClick={handleSave}
        disabled={saving || processing || !storageAvailable || !dirty}
        className="self-start px-6"
      >
        {saving ? "保存しています…" : "保存する"}
      </Button>
    </div>
  );
}

// お客様ページ(幅 390px 前後のスマートフォン)の作成中の画面を、縮めずに同じ部品で出す。
function PhonePreview({
  salonName,
  showcase,
  playing,
}: {
  salonName: string;
  showcase: { imageUrl: string; catchCopy: string } | null;
  playing: "idle" | "showcase" | "done";
}) {
  return (
    <div
      className="w-full max-w-[320px] overflow-hidden rounded-[2rem] border-[6px] border-ink/85 bg-ivory shadow-sm"
      aria-label="スマートフォンでの表示のプレビュー"
      role="img"
    >
      <div className="border-b border-greige/60 bg-white px-3 pt-3 pb-2.5 text-center">
        <p className="truncate text-sm font-medium text-stone-700">{salonName}</p>
        <p className="mt-0.5 text-[9px] font-medium tracking-[0.25em] text-earth">お客様アンケート</p>
      </div>
      <div className="flex min-h-[420px] flex-col px-3 py-4">
        {playing === "done" ? (
          <div className="flex flex-1 flex-col gap-3 animate-result-in">
            <p className="text-center text-sm font-medium leading-relaxed text-stone-700">
              ご協力ありがとうございます。
              <br />
              ご回答をもとに、口コミ文章を作成しました。
            </p>
            <div className="card space-y-2">
              <div className="h-2.5 w-full rounded-full bg-beige" />
              <div className="h-2.5 w-5/6 rounded-full bg-beige" />
              <div className="h-2.5 w-4/6 rounded-full bg-beige" />
            </div>
            <div className="btn-primary text-center text-sm">口コミをコピーして進む</div>
            <p className="text-center text-[11px] text-stone-400">（完成した口コミの画面の見本）</p>
          </div>
        ) : showcase ? (
          <GenerationShowcase showcase={showcase} salonName={salonName} fitViewport={false} />
        ) : (
          <div className="flex flex-1 flex-col gap-2">
            <ResultSkeleton />
            <p className="text-center text-[11px] text-stone-400">
              写真とキャッチコピーを設定すると、ここに表示されます。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
