"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Card from "@/components/ui/Card";
import Label from "@/components/ui/Label";
import Textarea from "@/components/ui/Textarea";
import Button, { buttonClassName } from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import Dialog from "@/components/ui/Dialog";
import LeaveGuard from "@/components/ui/LeaveGuard";
import StarRating from "@/components/ui/StarRating";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { useInbox } from "@/components/reviews/inbox/InboxContext";
import { reviewerName } from "@/components/reviews/inbox/ReviewListItem";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { useAutosizeTextarea } from "@/lib/useAutosizeTextarea";
import { charsOverLimit, displayLength } from "@/lib/replyGeneration/text";
import { suggestionPlacement } from "@/lib/replyGeneration/suggestion";
import type { ReplyWarningView } from "@/lib/replyGeneration/service";
import { formatCheckedAt, formatReviewDate } from "@/lib/googleReviews/format";
import { replyBucket, replyDisplayState, REPLY_STATE_NOTE } from "@/lib/googleReviews/replyState";
import type { ActionResult, GoogleReply, ReplySubmitRequest, ReplySubmitResult, ReviewDetail } from "@/lib/googleReviews/types";
import type { GenerateForReviewResult } from "@/app/dashboard/reviews/google/actions";

// 届いた口コミへの返信の文章(計画 第2版 §2「返信の状態」・§3-6・§3-A)。
//   AI返信案:「AIで返信案を作る」で、この口コミの本文と★(サーバーが読む)から案を作る。手直しした文章は上書きせず
//            「別の案」として出す。失敗しても文章は残す。結果の口コミ・選択の世代が今の表示と違えば表示しない。
//   投稿    :確認ダイアログ(店舗・口コミ・送る文章)→ 送信中は閉じない → 結果。自動で投稿することはない。
//            Google が受け付けたことと公開されたか(審査)は分けて表示する。
//   結果不明:時間切れなどで結果が分からないとき(送信結果を確認中)は、「Googleで確認する」(取り直し)だけを出す。
//            取り直して返信が無いと分かってから、初めて「もう一度送る」「送るのをやめる」を出す。
//   失敗    :送れなかった → もう一度送る。置き換え・削除の失敗 → 以前の返信が残っていることを示して、もう一度。
//   下書き  :入力が止まってから 1.5 秒後に自動で保存する(連携・店舗が変わったら保存されないが、入力は残す)。

const AUTOSAVE_MS = 1500;
const STALE_GENERATION = "Google連携または店舗が変わったため、返信案を表示しませんでした。一覧を読み込み直してください。";
const GOOGLE_BUSINESS_URL = "https://business.google.com/";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface ComposerTarget {
  salonName: string;
  locationTitle: string | null;
}

export interface ComposerActions {
  saveDraft: (id: string, text: string) => Promise<ActionResult<{ savedAt: string }>>;
  generate: (request: { reviewId: string; locationId: string; previousReply: string | null; regenerate: boolean }) => Promise<GenerateForReviewResult>;
  submitReply: (request: ReplySubmitRequest) => Promise<ReplySubmitResult>;
  dismissOperation: (id: string) => Promise<ActionResult>;
}

interface Props {
  review: ReviewDetail;
  target: ComposerTarget;
  actions: ComposerActions;
  onCheckLatest: () => void;
  checking: boolean;
  lastCheckedAt: string | null;
  onDraftSaved: (hasDraft: boolean) => void;
  /** 投稿・取り下げのあとに、最新の口コミ(Google の返信・操作の状態)を反映する。 */
  onReviewUpdated: (review: ReviewDetail) => void;
  nextUnrepliedHref: string | null;
  listHref: string;
}

interface Alternative {
  text: string;
  label: string;
  warnings: ReplyWarningView[];
}

interface PendingSend {
  action: "upsert" | "delete";
  opId: string;
  text: string | null;
  expectedReply: string | null;
}

/** 確認ダイアログを開いたときの操作の ID(同じ操作の再送は同じ ID で送る)。 */
function newOpId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function withOperation(review: ReviewDetail, operation: ReviewDetail["operation"]): ReviewDetail {
  return { ...review, operation, bucket: replyBucket(replyDisplayState({ reply: review.reply, operation })) };
}

export default function ReviewComposer({
  review,
  target,
  actions,
  onCheckLatest,
  checking,
  lastCheckedAt,
  onDraftSaved,
  onReviewUpdated,
  nextUnrepliedHref,
  listHref,
}: Props) {
  const textareaId = useId();
  const { locationId: listLocationId } = useInbox();
  const reviewId = review.id;
  const hasReply = review.reply !== null;
  const display = replyDisplayState(review);

  const [text, setText] = useState(review.draft);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // AI の案:直前に返信欄へ入れた案(手直ししたかどうかの判定)、別の案、作成中・失敗、注意。
  const [lastAiText, setLastAiText] = useState<string | null>(null);
  const [alternative, setAlternative] = useState<Alternative | null>(null);
  const [warnings, setWarnings] = useState<ReplyWarningView[]>([]);
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState<{ message: string; retryable: boolean } | null>(null);
  // 投稿:確認ダイアログ(開いたときに操作の ID を作る)・送信中・結果・競合。
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ send: PendingSend; outcome: ReplySubmitResult; at: string } | null>(null);
  const [conflict, setConflict] = useState<{ current: GoogleReply | null } | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const savedText = useRef(review.draft);
  // 返信欄の最新の文章と、直前に入れた AI の案。AI の案が届いた時点の判定に使う(作り始めた時点の値は使わない)。
  const latestText = useRef(review.draft);
  const lastAiRef = useRef<string | null>(null);
  // この返信欄が今も表示中で、同じ口コミのものか(離れた後に届いた案は、ほかの口コミに入れない)。
  const mounted = useRef(true);
  const reviewIdRef = useRef(reviewId);
  const resultRef = useRef<HTMLDivElement>(null);
  const textareaRef = useAutosizeTextarea(text);

  useEffect(() => {
    latestText.current = text;
  }, [text]);

  useEffect(() => {
    reviewIdRef.current = reviewId;
  }, [reviewId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function setLastAi(value: string | null) {
    lastAiRef.current = value;
    setLastAiText(value);
  }

  async function save(value: string) {
    setSaveState("saving");
    setSaveError(null);
    let res: ActionResult<{ savedAt: string }>;
    try {
      res = await actions.saveDraft(reviewId, value);
    } catch {
      res = { ok: false, error: "下書きを保存できませんでした。" };
    }
    if (!res.ok) {
      setSaveState("error");
      setSaveError(res.error);
      return;
    }
    savedText.current = value;
    onDraftSaved(value.trim().length > 0);
    // 保存している間に書き足していたら、もう一度保存する(下の effect が予約する)。
    setSaveState(latestText.current === value ? "saved" : "pending");
  }

  // 入力が止まってから保存する。
  useEffect(() => {
    if (saveState !== "pending") return;
    const timer = setTimeout(() => void save(latestText.current), AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 入力のたびに予約し直すため text も見る
  }, [saveState, text]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(null), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  // 結果が出たら、そこへスクロールする(Toast は使わない。BottomNav と重ならないように)。
  useEffect(() => {
    if (result || conflict) resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result, conflict]);

  function change(value: string) {
    latestText.current = value;
    setText(value);
    setSaveState(value === savedText.current ? "saved" : "pending");
  }

  /**
   * AI の案を受け取る。届いた時点の返信欄が空、または直前の AI の案のまま(手直ししていない)なら入れる。
   * 手直しした・生成を待つ間に入力した文章は残し、案は「別の案」として出す(lib/replyGeneration/suggestion.ts)。
   */
  function receiveSuggestion(value: string, suggestionWarnings: ReplyWarningView[], atRequest: string) {
    const placement = suggestionPlacement({ current: latestText.current, atRequest, lastAi: lastAiRef.current });
    if (placement === "replace") {
      change(value);
      setLastAi(value);
      setWarnings(suggestionWarnings);
      setAlternative(null);
      return;
    }
    setAlternative({ text: value, label: "別の案", warnings: suggestionWarnings });
  }

  async function generateHere(regenerate: boolean) {
    if (generating) return;
    const requestedFor = reviewId;
    const locationAt = review.locationId;
    const atRequest = latestText.current;
    setGenerating(true);
    setAiError(null);
    let res: GenerateForReviewResult;
    try {
      res = await actions.generate({ reviewId: requestedFor, locationId: locationAt, regenerate, previousReply: regenerate ? lastAiRef.current : null });
    } catch {
      res = { ok: false, error: "返信案を作れませんでした。もう一度お試しください。", retryable: true, reviewId: requestedFor };
    }
    // 待つ間に、ほかの口コミへ移った・この画面を離れた:届いた案は使わない。
    if (!mounted.current || reviewIdRef.current !== requestedFor) return;
    setGenerating(false);
    if (res.reviewId !== requestedFor) return;
    if (!res.ok) {
      setAiError({ message: res.error, retryable: res.retryable });
      return;
    }
    // 結果の世代が、今の口コミ・一覧の世代と違う(連携・店舗が変わった):表示しない。
    if (res.locationId !== locationAt || (listLocationId !== null && res.locationId !== listLocationId)) {
      setAiError({ message: STALE_GENERATION, retryable: false });
      return;
    }
    receiveSuggestion(res.reply, res.warnings, atRequest);
  }

  async function handleCopy() {
    const ok = await copyToClipboard(text);
    setCopyStatus(ok ? { ok: true, message: "コピーしました" } : { ok: false, message: "コピーできませんでした。文章を選択してコピーしてください。" });
  }

  function openConfirm(action: "upsert" | "delete", expectedReply: string | null = review.reply?.comment ?? null) {
    setPending({ action, opId: newOpId(), text: action === "upsert" ? text : null, expectedReply });
  }

  async function send(request: PendingSend) {
    if (sending) return;
    setSending(true);
    setDismissError(null);
    let outcome: ReplySubmitResult;
    try {
      outcome = await actions.submitReply({ reviewId, opId: request.opId, action: request.action, text: request.text, expectedReply: request.expectedReply });
    } catch {
      outcome = {
        kind: "unknown",
        message: "送信の結果を確認できませんでした。返信が反映されているかもしれません。「Googleで確認する」で確かめてください。確認できるまで、もう一度送らないでください。",
      };
    }
    setSending(false);
    setPending(null);
    setConflict(outcome.kind === "conflict" ? { current: outcome.current } : null);
    setResult(outcome.kind === "conflict" ? null : { send: request, outcome, at: new Date().toISOString() });
    if ("review" in outcome && outcome.review) {
      onReviewUpdated(outcome.review);
    } else if (outcome.kind === "unknown") {
      // 最新の口コミを受け取れなかったときも、取り直すまでは「送信結果を確認中」として扱う(もう一度送るボタンを出さない)。
      onReviewUpdated(withOperation(review, "unknown"));
    }
    if (outcome.kind === "accepted" && request.action === "upsert" && latestText.current === request.text) {
      savedText.current = latestText.current;
      setSaveState("idle");
    }
  }

  async function dismiss() {
    setDismissError(null);
    const res = await actions.dismissOperation(reviewId).catch((): ActionResult => ({ ok: false, error: "取り下げられませんでした。" }));
    if (!res.ok) {
      setDismissError(res.error);
      return;
    }
    setResult(null);
    onReviewUpdated(withOperation(review, "none"));
  }

  // 結果不明のあと、この画面で Google から取り直したか(取り直してもまだ反映を確認できないときの案内に使う)。
  const checkedSinceSend = lastCheckedAt !== null && (result === null || lastCheckedAt > result.at);
  // 結果不明は、上の「反映を確認できていません」の欄で説明と操作を出すので、送った結果の欄では同じ説明を繰り返さない。
  const visibleResult =
    result && !(lastCheckedAt !== null && lastCheckedAt > result.at && result.outcome.kind !== "accepted") && !(result.outcome.kind === "unknown" && display === "unconfirmed")
      ? result
      : null;

  const overChars = charsOverLimit(text);
  const unsaved = saveState === "pending" || saveState === "saving" || saveState === "error";
  const saveLabel: Record<SaveState, string> = {
    idle: review.draft && text === review.draft ? "保存済みの下書きを表示しています" : "",
    pending: "未保存",
    saving: "保存中…",
    saved: "下書きを保存しました",
    error: "保存できませんでした",
  };
  const textReady = text.trim().length > 0 && overChars === 0 && !sending;
  const name = reviewerName(review);
  const checkButton = (
    <Button type="button" size="sm" variant="secondary" onClick={onCheckLatest} disabled={checking}>
      {checking ? "確認しています…" : "Googleで確認する"}
    </Button>
  );

  // 状態ごとの主な操作(計画 第2版 §2 の表)。
  let statePanel: ReactNode = null;
  let postLabel: string | null = hasReply ? "Googleの返信を置き換える" : "Googleに返信する";
  let showDelete = hasReply;
  if (display === "sending") {
    postLabel = null;
    showDelete = false;
    statePanel = (
      <Alert variant="warning" className="flex flex-col gap-2">
        <span>Googleに送っている途中です。少し待ってから、Googleで確認してください。</span>
        <div>{checkButton}</div>
      </Alert>
    );
  } else if (display === "unconfirmed") {
    // 結果が分からない:Googleで確認する だけ。もう一度送る・別の返信・削除・送るのをやめる は出さない(サーバーも受け付けない)。
    // 取り直して送った内容が見えたときだけ、返信済みに変わる(時間がたっても「送れなかった」にはしない)。
    postLabel = null;
    showDelete = false;
    statePanel = (
      <Alert variant="warning" className="flex flex-col gap-2">
        <span className="font-medium">反映を確認できていません</span>
        <span>{REPLY_STATE_NOTE.unconfirmed}</span>
        {checkedSinceSend && lastCheckedAt && (
          <span>{formatCheckedAt(lastCheckedAt)}にGoogleで確認しましたが、まだ反映を確認できていません。少し時間をおいて、もう一度確認してください。</span>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {checkButton}
          <a href={GOOGLE_BUSINESS_URL} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "ghost", size: "sm" })}>
            Googleビジネスプロフィールを開く
            <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </Alert>
    );
  } else if (display === "checking") {
    // Google が受け付けた(送信は終わっている)。表示されたかは取り直して確かめる。
    postLabel = null;
    showDelete = false;
    statePanel = (
      <Alert variant="warning" className="flex flex-col gap-2">
        <span className="font-medium">送信結果を確認中</span>
        <span>{REPLY_STATE_NOTE.checking}</span>
        <div>{checkButton}</div>
      </Alert>
    );
  } else if (display === "send_failed") {
    postLabel = "もう一度送る";
    statePanel = (
      <Alert variant="error" className="flex flex-col gap-2">
        <span>{REPLY_STATE_NOTE.send_failed}</span>
        <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => void dismiss()}>
          送るのをやめる
        </Button>
      </Alert>
    );
  } else if (display === "replace_failed") {
    postLabel = "もう一度置き換える";
    statePanel = (
      <Alert variant="error" className="flex flex-col gap-2">
        <span className="font-medium">置き換えできませんでした(以前の返信が残っています)。</span>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-white p-3 text-ink">
            <p className="text-xs font-semibold">Googleに残っている返信</p>
            <p className="whitespace-pre-wrap break-words text-sm">{review.reply?.comment ?? "(返信はありません)"}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-white p-3 text-ink">
            <p className="text-xs font-semibold">編集中の文章</p>
            <p className="whitespace-pre-wrap break-words text-sm">{text || "(空です)"}</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => void dismiss()}>
          置き換えをやめる
        </Button>
      </Alert>
    );
  } else if (display === "delete_failed") {
    statePanel = (
      <Alert variant="error" className="flex flex-col gap-2">
        <span>{REPLY_STATE_NOTE.delete_failed}</span>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button type="button" size="sm" variant="secondary" onClick={() => openConfirm("delete")} disabled={sending}>
            もう一度削除する
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss()}>
            削除をやめる
          </Button>
        </div>
      </Alert>
    );
  } else if (display === "rejected") {
    postLabel = "内容を直して置き換える";
  }

  return (
    <Card className="flex flex-col gap-3">
      <LeaveGuard
        when={unsaved || sending}
        message={
          sending
            ? "返信を送っている途中です。移動しても送信は止まりませんが、結果はこの画面に表示されません。"
            : "返信の下書きを保存できていません。移動すると、保存されていない部分は消えます。"
        }
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor={textareaId} className="mb-0 text-sm font-semibold">
          {hasReply ? "Googleの返信を書き直す文章" : "返信の文章"}
        </Label>
        <p className="text-xs text-ink-muted">
          「Googleに返信する」を押すと、対象の店舗・口コミ・送る文章を確認してから、SalonPackからGoogleに投稿します。自動で投稿することはありません。
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-ivory p-3">
        <Button type="button" variant="secondary" className="self-start" onClick={() => void generateHere(lastAiText !== null)} disabled={generating}>
          {generating ? "返信案を作っています…" : lastAiText !== null ? "AIで別の案を作る" : "AIで返信案を作る"}
        </Button>
        <p className="text-xs text-ink-muted">
          この口コミの本文と★から、返信の設定に沿って案を作ります(投稿者の名前はAIに送りません。本文中の電話番号・メールアドレス・URLは伏せて送ります)。手直しした文章は上書きしません。
        </p>
        {aiError && (
          <Alert variant="error" className="flex flex-col gap-2">
            <span>{aiError.message} 返信欄の文章はそのまま残っています。</span>
            {aiError.retryable && (
              <Button type="button" size="sm" variant="secondary" className="self-start" onClick={() => void generateHere(lastAiText !== null)}>
                もう一度試す
              </Button>
            )}
          </Alert>
        )}
      </div>

      <Textarea
        id={textareaId}
        ref={textareaRef}
        value={text}
        rows={5}
        autoComplete="off"
        onChange={(e) => change(e.target.value)}
        aria-describedby={`${textareaId}-status`}
        aria-invalid={overChars > 0 || undefined}
        placeholder="返信の文章を入力するか、「AIで返信案を作る」で案を作ってください"
      />
      <div id={`${textareaId}-status`} className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-ink-muted">{displayLength(text)}文字</span>
        <span role="status" aria-live="polite" className={saveState === "error" ? "text-danger" : "text-ink-muted"}>
          {saveLabel[saveState]}
          {saveState === "error" && (
            <button type="button" onClick={() => void save(text)} className="ml-2 underline underline-offset-2">
              再試行
            </button>
          )}
        </span>
      </div>
      {overChars > 0 && <p className="text-xs text-danger">長すぎます。あと約{overChars}文字減らしてください。</p>}
      {saveError && saveState === "error" && <Alert variant="error">{saveError} 文章はこの画面に残っています。</Alert>}
      {warnings.length > 0 && lastAiText !== null && text.trim() === lastAiText.trim() && (
        <Alert variant="warning" className="flex flex-col gap-1">
          <span className="font-medium">投稿の前にご確認ください</span>
          <ul className="list-disc pl-5">
            {warnings.map((w) => (
              <li key={w.code}>{w.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      <p className="text-xs text-ink-muted">下書きは、この口コミの一時保存と一緒に最長25日間保存されます。</p>

      {alternative && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3" role="region" aria-label={alternative.label}>
          <p className="text-sm font-semibold text-ink">{alternative.label}</p>
          <p className="text-xs text-ink-muted">返信欄の文章は変えていません。使う方を選んでください。</p>
          <p className="whitespace-pre-wrap break-words text-sm text-ink">{alternative.text}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                change(alternative.text);
                setLastAi(alternative.label === "別の案" ? alternative.text : null);
                setWarnings(alternative.warnings);
                setAlternative(null);
              }}
            >
              この案に置き換える
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setAlternative(null)}>
              今の文章を残す
            </Button>
          </div>
        </div>
      )}

      {statePanel}
      {dismissError && <Alert variant="error">{dismissError}</Alert>}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {postLabel && (
          <Button type="button" onClick={() => openConfirm("upsert")} disabled={!textReady}>
            {postLabel}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={handleCopy} disabled={!text.trim()}>
          文章をコピー
        </Button>
        {review.replyUrl && (
          <a href={review.replyUrl} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "ghost" })}>
            Googleで開く
            <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
        <span role="status" aria-live="polite" className={copyStatus?.ok === false ? "text-sm text-danger" : "text-sm text-sage-dark"}>
          {copyStatus?.message ?? ""}
        </span>
      </div>
      {postLabel && !text.trim() && <p className="text-xs text-ink-muted">返信の文章を入力すると、Googleに返信できます。</p>}
      {showDelete && display !== "delete_failed" && (
        <Button type="button" variant="ghost" size="sm" className="self-start text-danger" onClick={() => openConfirm("delete")} disabled={sending}>
          Googleの返信を削除する
        </Button>
      )}

      <div ref={resultRef} className="flex flex-col gap-3">
        {conflict && (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-3" role="alert">
            <p className="text-sm font-semibold text-warning">Google上の返信が、確認したときから変わっていました。返信は送っていません。</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-white p-3">
                <p className="text-xs font-semibold text-ink">Google上の最新の返信</p>
                <p className="whitespace-pre-wrap break-words text-sm text-ink">{conflict.current?.comment ?? "(返信はありません)"}</p>
              </div>
              <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-white p-3">
                <p className="text-xs font-semibold text-ink">編集中の文章</p>
                <p className="whitespace-pre-wrap break-words text-sm text-ink">{text || "(空です)"}</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button type="button" size="sm" onClick={() => openConfirm("upsert", conflict.current?.comment ?? null)} disabled={!textReady}>
                編集中の文章で置き換える
              </Button>
              {conflict.current && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    // 編集中の文章は消さない(戻せるように残す)。
                    if (text.trim()) setAlternative({ text, label: "編集していた文章", warnings: [] });
                    change(conflict.current!.comment);
                    setLastAi(null);
                    setConflict(null);
                  }}
                >
                  Googleの返信をもとに編集し直す
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setConflict(null)}>
                やめる
              </Button>
            </div>
          </div>
        )}
        {visibleResult && (
          <SubmitOutcome
            result={visibleResult}
            checkButton={checkButton}
            nextUnrepliedHref={nextUnrepliedHref}
            listHref={listHref}
          />
        )}
      </div>

      <Dialog
        open={pending !== null}
        dismissible={!sending}
        title={pending?.action === "delete" ? "Googleの返信を削除しますか？" : hasReply ? "Googleの返信を置き換えますか？" : "Googleに返信しますか？"}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setPending(null)} disabled={sending}>
              {pending?.action === "delete" ? "やめる" : "戻って編集"}
            </Button>
            <Button type="button" onClick={() => pending && void send(pending)} disabled={sending}>
              {sending ? "送信しています…" : pending?.action === "delete" ? "削除する" : hasReply ? "置き換える" : "Googleに返信する"}
            </Button>
          </>
        }
      >
        {pending && (
          <div className="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto">
            <dl className="flex flex-col gap-3">
              <div>
                <dt className="text-xs text-ink-muted">店舗</dt>
                <dd className="break-words">
                  {target.salonName}
                  {target.locationTitle ? `(Googleのビジネス:${target.locationTitle})` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">口コミ</dt>
                <dd className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span className="font-medium text-ink">{name}</span>
                    <StarRating value={review.starRating} size="sm" />
                    <span>{formatReviewDate(review.createTime)}</span>
                  </span>
                  <span className="line-clamp-2 break-words">{review.comment.trim() || "(★のみの口コミです)"}</span>
                </dd>
              </div>
              {review.reply && (
                <div>
                  <dt className="text-xs text-ink-muted">{pending.action === "delete" ? "削除する返信" : "現在の返信(置き換わります)"}</dt>
                  <dd className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-ivory p-2">{review.reply.comment}</dd>
                </div>
              )}
              {pending.action === "upsert" && (
                <div>
                  <dt className="text-xs text-ink-muted">投稿する返信(全文)</dt>
                  <dd className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border p-2">{pending.text}</dd>
                </div>
              )}
            </dl>
            <p className="text-ink-muted">
              {pending.action === "delete"
                ? "Google上の返信を削除します。削除すると元に戻せません。"
                : "店舗の名前でGoogleに公開されます。公開の前にGoogleの審査があります。"}
            </p>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

function SubmitOutcome({
  result,
  checkButton,
  nextUnrepliedHref,
  listHref,
}: {
  result: { send: PendingSend; outcome: ReplySubmitResult };
  checkButton: ReactNode;
  nextUnrepliedHref: string | null;
  listHref: string;
}) {
  const { outcome, send } = result;
  const nav = (
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {nextUnrepliedHref && (
        <Link href={nextUnrepliedHref} className="font-medium text-sage-dark underline underline-offset-2">
          次の未返信の口コミへ ›
        </Link>
      )}
      <Link href={listHref} className="font-medium text-sage-dark underline underline-offset-2">
        一覧に戻る
      </Link>
    </div>
  );

  switch (outcome.kind) {
    case "accepted":
      return (
        <div className="flex flex-col gap-2 rounded-lg border border-sage/30 bg-sage-soft p-3 text-sm text-sage-dark" role="status">
          <span className="font-medium">
            {send.action === "delete" ? "Googleが返信の削除を受け付けました。" : "Googleが返信を受け付けました。"}
            {outcome.replayed ? "(この内容は、すでに送られていました。二重には送っていません)" : ""}
          </span>
          <span className="text-ink">
            {send.action === "delete"
              ? "Googleに反映されたかは、「Googleで確認する」で確かめられます。"
              : "公開の前にGoogleの審査があります。公開されたかは、「Googleで確認する」で確かめられます。"}
          </span>
          <div className="flex flex-wrap items-center gap-2">{checkButton}</div>
          {nav}
        </div>
      );
    case "unknown":
      // 操作のボタンは、上の「送信結果を確認中」の欄(Googleで確認する だけ)に出す。
      return <Alert variant="warning">{outcome.message}</Alert>;
    case "failed":
      return (
        <Alert variant="error" className="flex flex-col gap-2">
          <span>{outcome.message}</span>
          <span>返信欄の文章はそのまま残っています。{outcome.retryable ? "文章を確認して、もう一度送れます。" : ""}</span>
        </Alert>
      );
    case "busy":
      return (
        <Alert variant="warning" className="flex flex-col gap-2">
          <span>{outcome.message}</span>
          <div>{checkButton}</div>
        </Alert>
      );
    case "deleted_on_google":
      return <Alert variant="warning">{outcome.message} 返信欄の文章はコピーできます。</Alert>;
    case "mismatch":
    case "unavailable":
      return <Alert variant="error">{outcome.message}</Alert>;
    case "conflict":
      return null;
  }
}
