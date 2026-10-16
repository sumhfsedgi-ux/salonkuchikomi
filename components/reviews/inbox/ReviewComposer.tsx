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
import GoogleReplyBlock from "@/components/reviews/inbox/GoogleReplyBlock";
import ConnectionChangedNotice from "@/components/reviews/inbox/ConnectionChangedNotice";
import { useAutosizeTextarea } from "@/lib/useAutosizeTextarea";
import { charsOverLimit, displayLength } from "@/lib/replyGeneration/text";
import type { ReplyWarningView } from "@/lib/replyGeneration/service";
import { GBP_CONTENT_TTL_SECONDS } from "@/lib/gbp/store";
import { formatCheckedAt, formatReviewDate } from "@/lib/googleReviews/format";
import { CONNECTION_CHANGED_MESSAGE, isConnectionChangedMessage, RECHECK_LABEL } from "@/lib/googleReviews/messages";
import { replyBucket, replyDisplayState, REPLY_STATE_NOTE, type ReplyDisplayState } from "@/lib/googleReviews/replyState";
import type { ActionResult, GoogleReply, ReplySubmitRequest, ReplySubmitResult, ReviewDetail } from "@/lib/googleReviews/types";
import type { GenerateForReviewResult } from "@/app/dashboard/reviews/google/actions";

// 届いた口コミへの返信(計画 第2版 §2「返信の状態」・§3-6・§3-A)。
//   返信が無い  :「返信を作成」の欄(AI返信案・入力・下書き)→「返信内容を確認」→ 確認ダイアログ →「Googleに投稿する」。
//   返信がある  : Google の返信と「返信を編集」を中心に出す。編集を選んだときに入力欄を開く(下書きがあれば最初から開く)。
//                削除は「その他の操作」の中(確認ダイアログは残す)。
//   返信案      : 返信欄は1つ。「返信案を作成」(空のとき)・「作り直す」(文章があるとき)で、口コミと店舗の設定から作った案を
//                同じ返信欄に入れる(入力した文章の添削ではない)。手で書いた・直した文章や、手直しの有無が分からない保存済みの
//                下書きを置き換えるときだけ、先に確認する。置き換える直前の全文を1つだけ持ち、「前の文章に戻す」で戻せる
//                (この口コミの表示の中だけ。ほかの口コミ・連携先へは持ち越さない)。
//                作成中は返信欄を読み取り専用にし、投稿の確認も止める。結果を入れる直前に、口コミ・連携先・返信欄の文章が
//                依頼したときと同じかを確かめ、違えば入れない。失敗・キャンセルでは文章を変えない。
//   送信中・結果不明・送信結果を確認中: 状態の説明と「反映状況を再確認」を1か所にだけ出す。入力欄・AI は出さない(下書きは残す)。
//                結果不明は、取り直して送った内容が見えるまで、時間がたっても「送れなかった」にしない(サーバーも再送・変更・削除を受け付けない)。
//   下書き      : 入力が止まってから 1.5 秒後に自動で保存する。保存できなかったときは「保存できませんでした」と再試行を出す
//                (保存済みとは表示しない)。保存の期限は最後の保存から25日(gbp_save_draft の expires_at と同じ計算)。

const AUTOSAVE_MS = 1500;
const GOOGLE_BUSINESS_URL = "https://business.google.com/";
const IN_FLIGHT: ReadonlySet<ReplyDisplayState> = new Set(["sending", "unconfirmed", "checking"]);

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

/** 置き換える直前の文章(「前の文章に戻す」で戻す)と、置き換えた後の文章(戻す前に、その後の編集があるかを比べる)。 */
interface PreviousText {
  text: string;
  replacedWith: string;
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

/** 下書きの保存の期限(最後の保存から25日。DB の expires_at と同じ計算)。 */
function draftExpiry(savedAt: string | null): string | null {
  if (!savedAt) return null;
  const at = Date.parse(savedAt);
  return Number.isFinite(at) ? new Date(at + GBP_CONTENT_TTL_SECONDS * 1000).toISOString() : null;
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
  const reply = review.reply;
  const display = replyDisplayState(review);
  const inFlight = IN_FLIGHT.has(display);

  const [text, setText] = useState(review.draft);
  // 返信がある口コミは、下書きがあるとき・置き換えに失敗したときだけ、最初から入力欄を開く。
  const [editing, setEditing] = useState(() => !review.reply || review.draft.trim() !== "" || display === "replace_failed");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(review.draft.trim() ? review.draftUpdatedAt : null);
  // 返信案:直前に返信欄へ入れた案(手直ししたかどうかの判定)、置き換える前の文章、作成中・失敗、注意、確認のダイアログ。
  const [lastAiText, setLastAiText] = useState<string | null>(null);
  const [previous, setPrevious] = useState<PreviousText | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
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
  // 作成中か(二重に作らない。state の反映を待たずに判定する)。
  const generatingRef = useRef(false);
  // 下書きの保存を1つずつ順に行う(古い文章の保存が、新しい文章の保存の後に終わらないように)。
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  // この返信欄が今も表示中で、同じ口コミのものか(離れた後に届いた案は、ほかの口コミに入れない)。
  const mounted = useRef(true);
  const reviewIdRef = useRef(reviewId);
  const resultRef = useRef<HTMLDivElement>(null);
  const prevDisplay = useRef(display);
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

  // 送信中・結果不明のあと、取り直して Google の返信が見えたら、入力欄を閉じて返信を中心に出す(文章は残す)。
  useEffect(() => {
    if (IN_FLIGHT.has(prevDisplay.current) && !IN_FLIGHT.has(display) && review.reply) setEditing(false);
    prevDisplay.current = display;
  }, [display, review.reply]);

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
    setLastSavedAt(value.trim() ? res.value.savedAt : null);
    onDraftSaved(value.trim().length > 0);
    // 保存している間に書き足していたら、もう一度保存する(下の effect が予約する)。
    setSaveState(latestText.current === value ? "saved" : "pending");
  }

  // 入力が止まってから保存する。
  useEffect(() => {
    if (saveState !== "pending") return;
    // 保存は1つずつ順に行い、それぞれ実行する時点の最新の文章を保存する(最後に保存されるのは、いつも最新の文章)。
    const timer = setTimeout(() => {
      saveChain.current = saveChain.current.then(() => save(latestText.current));
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 入力のたびに予約し直すため text も見る
  }, [saveState, text]);

  // 結果が出たら、そこへスクロールする(Toast は使わない。BottomNav と重ならないように)。
  useEffect(() => {
    if (result || conflict) resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result, conflict]);

  function change(value: string) {
    latestText.current = value;
    setText(value);
    setSaveState(value === savedText.current ? "saved" : "pending");
  }

  function startEditing() {
    // 下書きが無ければ、今の Google の返信を入力欄に入れて始める(手を入れるまでは下書きとして保存しない)。
    if (!latestText.current.trim() && reply) {
      latestText.current = reply.comment;
      setText(reply.comment);
    }
    setEditing(true);
  }

  function stopEditing() {
    // 何も変えていなければ、返信の文章で埋めた入力欄を空に戻す。変えた文章は下書きとして残る(もう一度「返信を編集」で開ける)。
    if (reply && latestText.current === reply.comment && savedText.current === "") {
      latestText.current = "";
      setText("");
    }
    setAiError(null);
    setEditing(false);
  }

  /** 返信欄の文章を置き換える前に確認が要るか(文章があり、直前に入れた返信案のまま=未編集、ではない)。 */
  function needsReplaceConfirm(): boolean {
    const current = latestText.current;
    return current.trim() !== "" && !(lastAiRef.current !== null && current === lastAiRef.current);
  }

  function requestGenerate() {
    if (generatingRef.current || sending) return;
    if (needsReplaceConfirm()) {
      setConfirmRegenerate(true);
      return;
    }
    void generateHere();
  }

  async function generateHere() {
    if (generatingRef.current) return;
    generatingRef.current = true;
    const requestedFor = reviewId;
    const locationAt = review.locationId;
    const atRequest = latestText.current;
    const regenerate = lastAiRef.current !== null;
    setGenerating(true);
    setAiError(null);
    let res: GenerateForReviewResult;
    try {
      res = await actions.generate({ reviewId: requestedFor, locationId: locationAt, regenerate, previousReply: regenerate ? lastAiRef.current : null });
    } catch {
      res = { ok: false, error: "返信案を作成できませんでした。", retryable: true, reviewId: requestedFor };
    }
    generatingRef.current = false;
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
      setAiError({ message: CONNECTION_CHANGED_MESSAGE, retryable: false });
      return;
    }
    // 入れる直前に、返信欄が依頼したときのままかを確かめる(変わっていたら上書きしない)。
    if (latestText.current !== atRequest) {
      setAiError({ message: "返信案を作成している間に返信欄の文章が変わったため、返信案を入れませんでした。", retryable: true });
      return;
    }
    // 置き換える直前の全文を残す(空なら戻すものは無い)。
    setPrevious(atRequest.trim() ? { text: atRequest, replacedWith: res.reply } : null);
    change(res.reply);
    setLastAi(res.reply);
    setWarnings(res.warnings);
  }

  function requestRestore() {
    if (!previous || generatingRef.current) return;
    // 置き換えた後に手で直していたら、その編集が消えることを先に確認する。
    if (latestText.current !== previous.replacedWith) {
      setConfirmRestore(true);
      return;
    }
    restorePrevious();
  }

  function restorePrevious() {
    setConfirmRestore(false);
    if (!previous) return;
    change(previous.text);
    setLastAi(null);
    setWarnings([]);
    setPrevious(null);
  }

  function openConfirm(action: "upsert" | "delete", expectedReply: string | null = reply?.comment ?? null) {
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
        message: `送信の結果を確認できませんでした。返信が反映されているかもしれません。「${RECHECK_LABEL}」で確かめてください。確認できるまで、もう一度送らないでください。`,
      };
    }
    setSending(false);
    setPending(null);
    setConflict(outcome.kind === "conflict" ? { current: outcome.current } : null);
    setResult(outcome.kind === "conflict" ? null : { send: request, outcome, at: new Date().toISOString() });
    if ("review" in outcome && outcome.review) {
      onReviewUpdated(outcome.review);
    } else if (outcome.kind === "unknown") {
      // 最新の口コミを受け取れなかったときも、取り直すまでは結果不明として扱う(もう一度送るボタンを出さない)。
      onReviewUpdated(withOperation(review, "unknown"));
    }
    if (outcome.kind === "accepted") {
      if (request.action === "upsert" && latestText.current === request.text) {
        savedText.current = latestText.current;
        setSaveState("idle");
        setLastSavedAt(null);
      }
      setPrevious(null);
      setEditing(false);
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

  // 結果不明のあと、この画面で Google から取り直したか(最終確認の時刻の表示に使う)。
  const checkedSinceSend = lastCheckedAt !== null && (result === null || lastCheckedAt > result.at);
  // 結果不明は状態の欄で説明と操作を出すので、送った結果の欄では同じ説明を繰り返さない。
  const visibleResult =
    result && !(lastCheckedAt !== null && lastCheckedAt > result.at && result.outcome.kind !== "accepted") && !(result.outcome.kind === "unknown" && display === "unconfirmed")
      ? result
      : null;

  const overChars = charsOverLimit(text);
  const unsaved = saveState === "pending" || saveState === "saving" || saveState === "error";
  const saveLabel: Record<SaveState, string> = {
    idle: review.draft.trim() && text === review.draft ? "下書き保存済み" : "",
    pending: "保存中…",
    saving: "保存中…",
    saved: text.trim() ? "下書き保存済み" : "",
    error: "保存できませんでした",
  };
  const expiresAt = text.trim() && (saveState === "saved" || (saveState === "idle" && text === review.draft)) ? draftExpiry(lastSavedAt) : null;
  const unchanged = reply !== null && text.trim() === reply.comment.trim();
  const textReady = text.trim().length > 0 && overChars === 0 && !sending && !generating && !unchanged;
  const name = reviewerName(review);
  const checkButton = (
    <Button type="button" size="sm" variant="secondary" onClick={onCheckLatest} disabled={checking}>
      {checking ? "確認しています…" : RECHECK_LABEL}
    </Button>
  );
  const sentText = result && result.send.action === "upsert" ? result.send.text : null;
  const editorOpen = !inFlight && (reply === null || editing);
  const showMoreActions = reply !== null && !inFlight && display !== "delete_failed";
  const postLabel = reply ? "変更内容を確認" : "返信内容を確認";

  // 送信中・結果不明・送信結果を確認中:説明と「反映状況を再確認」を1か所にだけ出す。
  let inFlightPanel: ReactNode = null;
  if (inFlight && !(display === "checking" && visibleResult?.outcome.kind === "accepted")) {
    const deleting = result?.send.action === "delete";
    const title =
      display === "sending" ? "送信中…" : display === "checking" ? "送信結果を確認中" : deleting ? "削除の反映を確認できていません" : "反映を確認できていません";
    const note =
      display === "sending"
        ? `Googleに送っている途中です。少し待ってから「${RECHECK_LABEL}」で確かめてください。`
        : display === "checking"
          ? `${REPLY_STATE_NOTE.checking} 表示されたかは「${RECHECK_LABEL}」で確かめられます。`
          : REPLY_STATE_NOTE.unconfirmed;
    inFlightPanel = (
      <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-ink" role="status">
        <p className="font-semibold text-warning">{title}</p>
        <p>{note}</p>
        {display === "unconfirmed" && (
          <p className="text-xs text-ink-muted">
            最終確認:
            {checkedSinceSend && lastCheckedAt ? `${formatCheckedAt(lastCheckedAt)}(この時点では反映を確認できませんでした)` : "この画面ではまだ確認していません"}
          </p>
        )}
        {sentText && (
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-white p-3">
            <p className="text-xs font-semibold text-ink-muted">送信した返信</p>
            <p className="whitespace-pre-wrap break-words">{sentText}</p>
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {checkButton}
          {display === "unconfirmed" && (
            <a href={GOOGLE_BUSINESS_URL} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "ghost", size: "sm" })}>
              Googleの管理画面を開く
              <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
            </a>
          )}
        </div>
        {display === "unconfirmed" && text.trim() && text !== sentText && (
          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer">保存している下書きを見る</summary>
            <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border bg-white p-2 text-sm text-ink">{text}</p>
          </details>
        )}
      </div>
    );
  }

  // 送れなかった・変更や削除に失敗した(送っていない・以前の返信が残っていると分かっている)。
  let failurePanel: ReactNode = null;
  if (display === "send_failed") {
    failurePanel = (
      <Alert variant="error" className="flex flex-col gap-2">
        <span>{REPLY_STATE_NOTE.send_failed}</span>
        <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => void dismiss()}>
          送るのをやめる
        </Button>
      </Alert>
    );
  } else if (display === "replace_failed") {
    failurePanel = (
      <Alert variant="error" className="flex flex-col gap-2">
        <span className="font-medium">{REPLY_STATE_NOTE.replace_failed}</span>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-white p-3 text-ink">
            <p className="text-xs font-semibold">Googleに残っている返信</p>
            <p className="whitespace-pre-wrap break-words text-sm">{reply?.comment ?? "(返信はありません)"}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-white p-3 text-ink">
            <p className="text-xs font-semibold">編集中の文章</p>
            <p className="whitespace-pre-wrap break-words text-sm">{text || "(空です)"}</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => void dismiss()}>
          変更をやめる
        </Button>
      </Alert>
    );
  } else if (display === "delete_failed") {
    failurePanel = (
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
  }

  const dialogIsChange = pending?.action === "upsert" && pending.expectedReply !== null;

  return (
    <div className="flex flex-col gap-4">
      <LeaveGuard
        when={unsaved || sending}
        message={
          sending
            ? "返信を送っている途中です。移動しても送信は止まりませんが、結果はこの画面に表示されません。"
            : "返信の下書きを保存できていません。移動すると、保存されていない部分は消えます。"
        }
      />

      <GoogleReplyBlock reply={reply} operation={review.operation}>
        {!editorOpen && !inFlight && (
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Button type="button" variant={display === "rejected" ? "primary" : "secondary"} size="sm" onClick={startEditing}>
              返信を編集
            </Button>
            {text.trim() && reply && text !== reply.comment && <span className="text-xs text-ink-muted">編集中の下書きがあります</span>}
          </div>
        )}
        {showMoreActions && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-ink-muted">その他の操作</summary>
            <div className="mt-2">
              <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={() => openConfirm("delete")} disabled={sending}>
                Googleの返信を削除…
              </Button>
            </div>
          </details>
        )}
      </GoogleReplyBlock>

      {inFlightPanel}
      {failurePanel}
      {dismissError && <Alert variant="error">{dismissError}</Alert>}

      {editorOpen && (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={textareaId} className="mb-0 text-sm font-semibold">
              {reply ? "返信を編集" : "返信を作成"}
            </Label>
            <p className="text-xs text-ink-muted">内容を確認してからGoogleに投稿できます。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Button type="button" variant="secondary" size="sm" className="self-start" onClick={requestGenerate} disabled={generating || sending}>
              {generating ? "返信案を作成しています…" : text.trim() ? "作り直す" : "返信案を作成"}
            </Button>
            <details className="text-xs text-ink-muted">
              <summary className="cursor-pointer">AIの利用について</summary>
              <p className="mt-1">
                「返信案を作成」「作り直す」を押したときだけ、この口コミの本文と★を、店舗名・業種・店舗の紹介文・AI返信の設定と一緒にAI(OpenAI)に送り、返信案を作ります。返信欄に入力した文章は送りません。投稿者の名前・写真は送りません。本文中の電話番号・メールアドレス・URLは伏せて送ります。返信欄の文章を置き換えるときは、前の文章に戻せます。
              </p>
            </details>
            {aiError &&
              (isConnectionChangedMessage(aiError.message) ? (
                <ConnectionChangedNotice message={aiError.message} text={text} reloadHref={listHref} />
              ) : (
                <Alert variant="error" className="flex flex-col gap-2">
                  <span>
                    {aiError.message}
                    {text.trim() ? " 入力した文章は残っています。" : ""}
                  </span>
                  {aiError.retryable && (
                    <Button type="button" size="sm" variant="secondary" className="self-start" onClick={requestGenerate} disabled={generating}>
                      もう一度作成
                    </Button>
                  )}
                </Alert>
              ))}
          </div>

          <Textarea
            id={textareaId}
            ref={textareaRef}
            value={text}
            rows={5}
            autoComplete="off"
            onChange={(e) => change(e.target.value)}
            readOnly={generating}
            aria-busy={generating || undefined}
            aria-describedby={`${textareaId}-status`}
            aria-invalid={overChars > 0 || undefined}
            placeholder="返信を入力するか、「返信案を作成」を押してください"
          />
          <div id={`${textareaId}-status`} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-3 text-ink-muted">
              <span>{displayLength(text)}文字</span>
              {previous && (
                <button type="button" onClick={requestRestore} disabled={generating} className="underline underline-offset-2 hover:text-ink disabled:opacity-50">
                  前の文章に戻す
                </button>
              )}
            </span>
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
          {saveError &&
            saveState === "error" &&
            (isConnectionChangedMessage(saveError) ? (
              <ConnectionChangedNotice message={saveError} text={text} reloadHref={listHref} />
            ) : (
              <Alert variant="error">{saveError} 文章はこの画面に残っています。</Alert>
            ))}
          {expiresAt && <p className="text-xs text-ink-muted">下書きは{formatCheckedAt(expiresAt)}まで保存されます(最後の保存から25日)。</p>}
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

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Button type="button" onClick={() => openConfirm("upsert")} disabled={!textReady}>
              {postLabel}
            </Button>
            {reply && (
              <Button type="button" variant="ghost" onClick={stopEditing} disabled={sending || generating}>
                編集をやめる
              </Button>
            )}
          </div>
          {!text.trim() ? (
            <p className="text-xs text-ink-muted">返信を入力すると、内容を確認できます。</p>
          ) : unchanged ? (
            <p className="text-xs text-ink-muted">文章を変更すると、変更内容を確認できます。</p>
          ) : null}
        </Card>
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
              <Button type="button" size="sm" onClick={() => openConfirm("upsert", conflict.current?.comment ?? null)} disabled={!text.trim() || overChars > 0 || sending}>
                {conflict.current ? "編集中の文章で変更内容を確認" : "編集中の文章で返信内容を確認"}
              </Button>
              {conflict.current && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    // 編集中の文章は消さない(「前の文章に戻す」で戻せるように残す)。
                    const current = conflict.current!.comment;
                    setPrevious(text.trim() ? { text, replacedWith: current } : null);
                    change(current);
                    setLastAi(null);
                    setEditing(true);
                    setConflict(null);
                  }}
                >
                  Googleの返信をもとに編集し直す
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setConflict(null)}>
                閉じる
              </Button>
            </div>
          </div>
        )}
        {visibleResult && (
          <SubmitOutcome
            result={visibleResult}
            checkButton={checkButton}
            hasText={text.trim().length > 0}
            text={text}
            confirmed={!inFlight && display !== "pending" && lastCheckedAt !== null && lastCheckedAt > visibleResult.at}
            nextUnrepliedHref={nextUnrepliedHref}
            listHref={listHref}
          />
        )}
      </div>

      <Dialog
        open={confirmRegenerate}
        title="編集中の文章を作り直しますか？"
        onClose={() => setConfirmRegenerate(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirmRegenerate(false)}>
              キャンセル
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmRegenerate(false);
                void generateHere();
              }}
            >
              作り直す
            </Button>
          </>
        }
      >
        <p>新しい返信案に置き換えます。置き換え後も、前の文章に戻せます。</p>
      </Dialog>

      <Dialog
        open={confirmRestore}
        title="前の文章に戻しますか？"
        onClose={() => setConfirmRestore(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirmRestore(false)}>
              キャンセル
            </Button>
            <Button type="button" onClick={restorePrevious}>
              前の文章に戻す
            </Button>
          </>
        }
      >
        <p>作り直したあとに編集した内容は消えます。</p>
      </Dialog>

      <Dialog
        open={pending !== null}
        dismissible={!sending}
        title={pending?.action === "delete" ? "Googleの返信を削除しますか？" : dialogIsChange ? "この内容で返信を変更しますか？" : "この内容でGoogleに投稿しますか？"}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setPending(null)} disabled={sending}>
              {pending?.action === "delete" ? "やめる" : "編集に戻る"}
            </Button>
            <Button type="button" onClick={() => pending && void send(pending)} disabled={sending}>
              {sending
                ? pending?.action === "delete"
                  ? "削除しています…"
                  : "投稿しています…"
                : pending?.action === "delete"
                  ? "削除する"
                  : dialogIsChange
                    ? "変更を投稿する"
                    : "Googleに投稿する"}
            </Button>
          </>
        }
      >
        {pending && (
          <div className="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto">
            <dl className="flex flex-col gap-3">
              <div>
                <dt className="text-xs text-ink-muted">投稿先(Googleの店舗)</dt>
                <dd className="flex flex-col gap-0.5 break-words">
                  <span className="font-medium text-ink">{target.locationTitle ?? target.salonName}</span>
                  {target.locationTitle && target.locationTitle !== target.salonName && (
                    <span className="text-xs text-ink-muted">SalonPackの「{target.salonName}」と連携しているGoogleの店舗です</span>
                  )}
                  {!target.locationTitle && <span className="text-xs text-ink-muted">Googleの店舗名を取得できていないため、SalonPackの店舗名を表示しています</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">対象の口コミ</dt>
                <dd className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span className="font-medium text-ink">{name}</span>
                    <StarRating value={review.starRating} size="sm" />
                    <span>{formatReviewDate(review.createTime)}</span>
                  </span>
                  <span className="line-clamp-2 break-words">{review.comment.trim() || "(★のみの口コミです)"}</span>
                </dd>
              </div>
              {pending.expectedReply !== null && (
                <div>
                  <dt className="text-xs text-ink-muted">{pending.action === "delete" ? "削除する返信" : "今の返信(変更後は置き換わります)"}</dt>
                  <dd className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-ivory p-2">{pending.expectedReply}</dd>
                </div>
              )}
              {pending.action === "upsert" && (
                <div>
                  <dt className="text-xs text-ink-muted">{dialogIsChange ? "変更後の返信(全文)" : "投稿する返信(全文)"}</dt>
                  <dd className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border p-2">{pending.text}</dd>
                </div>
              )}
            </dl>
            <p className="text-ink-muted">
              {pending.action === "delete"
                ? "Google上の返信を削除します。削除すると元に戻せません。"
                : "店舗の名前でGoogleに公開されます。公開前にGoogleの審査が入ることがあります。"}
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function SubmitOutcome({
  result,
  checkButton,
  hasText,
  text,
  confirmed,
  nextUnrepliedHref,
  listHref,
}: {
  result: { send: PendingSend; outcome: ReplySubmitResult; at: string };
  checkButton: ReactNode;
  hasText: boolean;
  text: string;
  /** 受け付けのあと、取り直して Google の状態(審査中以外)を確かめた。状態は Google の返信の欄に出ているので、次の操作だけを出す。 */
  confirmed: boolean;
  nextUnrepliedHref: string | null;
  listHref: string;
}) {
  const { outcome, send } = result;
  const nav = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {nextUnrepliedHref ? (
        <Link href={nextUnrepliedHref} className="font-medium text-sage-dark underline underline-offset-2">
          次の未返信の口コミへ ›
        </Link>
      ) : (
        <span className="text-ink-muted">一覧に、ほかの未返信の口コミはありません。</span>
      )}
      <Link href={listHref} className="font-medium text-sage-dark underline underline-offset-2">
        一覧に戻る
      </Link>
    </div>
  );
  if ("message" in outcome && isConnectionChangedMessage(outcome.message)) {
    return <ConnectionChangedNotice message={outcome.message} text={text} reloadHref={listHref} />;
  }

  switch (outcome.kind) {
    case "accepted":
      if (confirmed) return nav;
      return (
        <div className="flex flex-col gap-2 rounded-lg border border-sage/30 bg-sage-soft p-3 text-sm text-sage-dark" role="status">
          <span className="font-medium">
            {send.action === "delete" ? "Googleが返信の削除を受け付けました。" : "Googleが返信を受け付けました。"}
            {outcome.replayed ? "(この内容は、すでに送られていました。二重には送っていません)" : ""}
          </span>
          <span className="text-ink">
            {send.action === "delete"
              ? `反映されたかは「${RECHECK_LABEL}」で確かめられます。`
              : `公開前にGoogleの審査が入ることがあります。反映されたかは「${RECHECK_LABEL}」で確かめられます。`}
          </span>
          <div className="flex flex-wrap items-center gap-2">{checkButton}</div>
          {nav}
        </div>
      );
    case "unknown":
      // 操作のボタンは、状態の欄(「反映状況を再確認」だけ)に出す。
      return <Alert variant="warning">{outcome.message}</Alert>;
    case "failed":
      return (
        <Alert variant="error" className="flex flex-col gap-2">
          <span>{outcome.message}</span>
          {hasText && <span>返信欄の文章は残っています。{outcome.retryable ? "文章を確認して、もう一度送れます。" : ""}</span>}
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
      return <Alert variant="warning">{outcome.message}{hasText ? " 返信欄の文章はこの画面に残っています。" : ""}</Alert>;
    case "mismatch":
    case "unavailable":
      return <Alert variant="error">{outcome.message}</Alert>;
    case "conflict":
      return null;
  }
}
