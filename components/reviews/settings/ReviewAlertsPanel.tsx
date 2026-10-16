"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import Button, { buttonClassName } from "@/components/ui/Button";
import Toast from "@/components/Toast";
import { IssuedInviteCard } from "@/components/notifications/RecipientsPanel";
import {
  createReviewInviteAction,
  reissueReviewInviteAction,
  removeReviewRecipientAction,
  revokeReviewInviteAction,
  sendReviewAlertTestAction,
  setReviewRecipientAction,
  startReviewAlertsAction,
  stopReviewAlertsAction,
  type ReviewIssuedInvite,
} from "@/app/dashboard/reviews/settings/alertActions";
import { LOCKED_SETTING_MESSAGE, testSendNotice, type TestSendMode } from "@/lib/notifications/recipients/messages";
import { alertBadge, blockingReason, deliveryStatusText, startChecklist, stopReasonText, type ReviewAlertState } from "@/lib/reviews/alerts/status";
import type { ReviewAlertPanelData } from "@/lib/reviews/alerts/ownerData";

// 口コミの設定タブの「LINE通知」。開始・停止、通知先ごとの口コミ通知の ON/OFF・招待・解除、テスト通知、最近の通知。
// LINE には店舗名と確認のボタンだけを送る(口コミの内容・評価・投稿者名は送らない。lib/reviews/alerts/message.ts)。
// 表示は DB の値から作り(lib/reviews/alerts/status.ts)、操作の可否はサーバーの Server Action・DB 関数で確かめる。

interface Props {
  salonName: string;
  data: ReviewAlertPanelData;
  state: ReviewAlertState;
  invitesAvailable: boolean;
  sendMode: TestSendMode;
  /** 実際にテスト通知を送る通知先の人数(シミュレーションでは 0)。 */
  realTestRecipients: number;
}

function formatJst(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

type ActionResult = { ok: true; message?: string; invite?: ReviewIssuedInvite } | { ok: false; error: string };

function useRunner() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<ActionResult>): Promise<ActionResult | null> {
    if (busy) return null;
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) setError(result.error);
    router.refresh();
    return result;
  }
  return { busy, error, run };
}

function StartStop({ data, state }: Pick<Props, "data" | "state">) {
  const { busy, error, run } = useRunner();
  const [confirming, setConfirming] = useState<"start" | "stop" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const checklist = startChecklist(state);
  const canStart = state.alertsAvailable && checklist.every((c) => c.ok);
  const restart = Boolean(data.settings.notifyFrom);

  if (data.settings.enabled) {
    return (
      <div className="flex flex-col gap-2">
        {data.settings.notifyFrom && <p className="text-xs text-ink-muted">{formatJst(data.settings.notifyFrom)}より後に投稿された口コミをお知らせしています。</p>}
        {confirming === "stop" ? (
          <div role="group" aria-label="LINE通知の停止の確認" className="flex flex-col gap-2 rounded-lg border border-border bg-white p-3">
            <p className="text-sm text-ink">停止中に投稿された口コミは、再開してもお知らせしません。送信を始めたものは取り消せません。停止しますか?</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  const result = await run(stopReviewAlertsAction);
                  setConfirming(null);
                  if (result?.ok && result.message) setMessage(result.message);
                }}
              >
                停止する
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                やめる
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className={buttonClassName({ variant: "secondary", size: "sm", className: "w-fit" })} onClick={() => setConfirming("stop")}>
            LINE通知を停止する
          </button>
        )}
        {message && <Alert variant="success">{message}</Alert>}
        {error && <Alert variant="error">{error}</Alert>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-semibold text-ink-muted">開始の条件</p>
        <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="alert-checklist">
          {checklist.map((c) => (
            <li key={c.key} className={c.ok ? "text-ink" : "text-ink-muted"}>
              <span aria-hidden="true">{c.ok ? "✓ " : "・ "}</span>
              {c.label}
              <span className="sr-only">{c.ok ? "(済み)" : "(まだです)"}</span>
            </li>
          ))}
        </ul>
      </div>
      {confirming === "start" ? (
        <div role="group" aria-label="LINE通知の開始の確認" className="flex flex-col gap-2 rounded-lg border border-border bg-white p-3">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
            <li>{restart ? "再開した" : "開始した"}時刻より後に投稿された口コミだけをお知らせします。</li>
            <li>LINEには店舗名と確認ボタンだけを送ります。口コミの内容・評価・投稿者名は送りません。</li>
            <li>Googleの通知の設定にSalonPackを登録し、新しい口コミをすぐに確認します(ほかのサービスが使っている場合は変更しません)。</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={async () => {
                const result = await run(() => startReviewAlertsAction(data.settings.version));
                setConfirming(null);
                if (result?.ok) setMessage(null);
              }}
            >
              {restart ? "再開する" : "開始する"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
              やめる
            </Button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={!canStart} className={buttonClassName({ size: "sm", className: "w-fit" })} onClick={() => setConfirming("start")}>
          {restart ? "LINE通知を再開する" : "LINE通知を開始する"}
        </button>
      )}
      {message && <Alert variant="success">{message}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}

function RecipientRow({ recipient, alertsAvailable }: { recipient: ReviewAlertPanelData["recipients"][number]; alertsAvailable: boolean }) {
  const { busy, error, run } = useRunner();
  const [on, setOn] = useState(recipient.reviewOn);

  async function toggle(next: boolean) {
    setOn(next);
    const result = await run(() => setReviewRecipientAction(recipient.id, next));
    if (result && !result.ok) setOn(!next);
  }

  async function remove() {
    if (!window.confirm(`「${recipient.label}」を通知先から解除します。解除すると、このLINEには予約通知と口コミ通知の両方が届かなくなります。よろしいですか?`)) return;
    await run(() => removeReviewRecipientAction(recipient.id));
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0" data-testid="review-recipient-row">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{recipient.label}</span>
        <Badge variant={recipient.connected ? "success" : "neutral"} dot>
          {recipient.connected ? "連携済み" : "未接続"}
        </Badge>
      </div>
      <label className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm text-ink">
          口コミ通知
          {on && recipient.onSince && <span className="ml-2 text-xs text-ink-muted">{formatJst(recipient.onSince)}から</span>}
        </span>
        <input
          type="checkbox"
          className="h-5 w-5 shrink-0 accent-sage-dark"
          checked={on}
          disabled={busy || (!on && (!recipient.connected || !alertsAvailable))}
          onChange={(e) => toggle(e.target.checked)}
          aria-label={`${recipient.label}の口コミ通知`}
        />
      </label>
      {recipient.changeLocked ? (
        <p className="text-xs text-ink-muted">{LOCKED_SETTING_MESSAGE}</p>
      ) : (
        <button type="button" disabled={busy} onClick={remove} className="w-fit text-xs text-danger underline underline-offset-2 disabled:opacity-50">
          通知先から解除
        </button>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}

function Recipients({ data, state, invitesAvailable }: Pick<Props, "data" | "state" | "invitesAvailable">) {
  const { busy, error, run } = useRunner();
  const [adding, setAdding] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [issued, setIssued] = useState<ReviewIssuedInvite | null>(null);
  const canInvite = invitesAvailable && state.alertsAvailable;

  async function runInvite(action: () => Promise<ActionResult>) {
    const result = await run(action);
    if (result?.ok && result.invite) setIssued(result.invite);
    return result;
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-ink">通知先(予約通知と共通)</h3>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-muted">
          <li>LINEで通知を受け取ることと、SalonPackで口コミを見ることは別です。［口コミを確認する］の先は、この店舗のSalonPackにログインできる方だけが開けます。</li>
          <li>口コミ通知をONにした時刻より前に投稿された口コミは、その方には送りません。OFFにすると、まだ送っていない通知も送りません。</li>
          <li>通知先1人ごとに、口コミ1件あたりLINEの送信が1通増えます(予約通知と同じLINE公式アカウントの月間通数を使います)。</li>
          <li>LINEの中のブラウザで開くと、SalonPackへのログインをあらためて求められる場合があります。</li>
        </ul>
      </div>

      {data.recipients.length === 0 ? (
        <p className="text-sm text-ink-muted">通知先はまだありません。</p>
      ) : (
        <div className="flex flex-col gap-3">
          {data.recipients.map((r) => (
            <RecipientRow key={`${r.id}:${r.reviewOn}:${r.onSince}`} recipient={r} alertsAvailable={state.alertsAvailable} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        {!canInvite ? (
          <p className="text-sm text-ink-muted">LINEの通知先の追加は準備中です。</p>
        ) : issued ? (
          <IssuedInviteCard invite={issued} onClose={() => setIssued(null)} />
        ) : adding ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runInvite(() => createReviewInviteAction(displayName)).then((result) => {
                if (result?.ok) {
                  setAdding(false);
                  setDisplayName("");
                }
              });
            }}
          >
            <label htmlFor="review-invite-name" className="text-sm text-ink">
              通知先の表示名(例:山田、受付)
            </label>
            <input
              id="review-invite-name"
              value={displayName}
              maxLength={40}
              required
              onChange={(e) => setDisplayName(e.target.value)}
              className="rounded-md border border-border px-3 py-2 text-sm"
            />
            <p className="text-xs text-ink-muted">登録が終わったら、この画面でその方の口コミ通知をONにしてください(登録しただけでは口コミ通知は届きません)。</p>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                招待を作成
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                やめる
              </Button>
            </div>
          </form>
        ) : (
          <button type="button" className={buttonClassName({ variant: "secondary", size: "sm", className: "w-fit" })} onClick={() => setAdding(true)}>
            通知先を追加
          </button>
        )}
        {error && <Alert variant="error">{error}</Alert>}
      </div>

      {canInvite && data.invites.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h4 className="text-xs font-semibold text-ink-muted">まだ使われていない招待</h4>
          {data.invites.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink">
                {invite.displayName}
                <span className="ml-2 text-xs text-ink-muted">{invite.expired ? "期限切れ" : `期限 ${formatJst(invite.expiresAt)}`}</span>
              </span>
              <span className="flex gap-2">
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => runInvite(() => reissueReviewInviteAction(invite.id))}>
                  再発行
                </Button>
                {!invite.expired && (
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => revokeReviewInviteAction(invite.id))}>
                    取消
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function TestSend({ disabled, sendMode, realTestRecipients }: { disabled: boolean; sendMode: TestSendMode; realTestRecipients: number }) {
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: "success" | "error" } | null>(null);
  const real = sendMode !== "simulated" && realTestRecipients > 0;

  async function send() {
    setSending(true);
    setConfirming(false);
    const result = await sendReviewAlertTestAction();
    setSending(false);
    setToast(result.ok ? { message: result.message, variant: "success" } : { message: result.error, variant: "error" });
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">口コミ通知がONの通知先にだけ送ります。{testSendNotice(sendMode, realTestRecipients)}</p>
      {confirming ? (
        <div role="group" aria-label="テスト通知の確認" className="flex flex-col gap-2 rounded-lg border border-border bg-white p-3">
          <p className="text-sm text-ink">{realTestRecipients}人のLINEに、実際にテスト通知を送ります。送信してよろしいですか?</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={send} disabled={sending}>
              送信する
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={sending}>
              やめる
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="secondary" className="w-fit" disabled={disabled || sending} onClick={real ? () => setConfirming(true) : send}>
          {sending ? "送信しています..." : real ? "LINEにテスト通知を送る" : "テスト通知をシミュレーションする"}
        </Button>
      )}
      <Toast message={toast?.message ?? null} variant={toast?.variant} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default function ReviewAlertsPanel({ salonName, data, state, invitesAvailable, sendMode, realTestRecipients }: Props) {
  const badge = alertBadge(state);
  const stopped = data.settings.enabled ? null : stopReasonText(data.settings.stopReason);
  const blocking = data.settings.enabled ? (blockingReason(state) ?? (state.activeRecipients === 0 ? "口コミ通知がONの通知先がいないため、送信していません。" : null)) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-ink">新しい口コミのLINE通知</p>
          <Badge variant={badge.tone} dot>
            {badge.label}
          </Badge>
        </div>
        {!state.alertsAvailable ? (
          <p className="text-sm text-ink-muted">口コミのLINE通知は準備中です。</p>
        ) : (
          <>
            <p className="text-sm text-ink-muted">
              新しい口コミが届くと、「【SalonPack】{salonName || "ご登録の店舗"} / 新しい口コミが届きました。」と［口コミを確認する］のボタンをLINEに送ります。口コミの内容・評価・投稿者名は送りません。
            </p>
            {stopped && <Alert variant="warning">{stopped}</Alert>}
            {blocking && <Alert variant="warning">{blocking}</Alert>}
            <StartStop data={data} state={state} />
          </>
        )}
      </Card>

      <Recipients data={data} state={state} invitesAvailable={invitesAvailable} />

      {state.alertsAvailable && (
        <Card className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-ink">テスト通知</h3>
          <TestSend disabled={state.activeRecipients === 0} sendMode={sendMode} realTestRecipients={realTestRecipients} />
        </Card>
      )}

      {data.recent.length > 0 && (
        <Card className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">最近の通知</h3>
          <ul className="flex flex-col gap-1 text-sm" data-testid="review-alert-recent">
            {data.recent.map((d) => (
              <li key={d.id} className="flex flex-wrap justify-between gap-x-3">
                <span className="text-ink">
                  {formatJst(d.createdAt)} {d.recipientLabel}
                </span>
                <span className="text-ink-muted">{deliveryStatusText(d.status, d.skipReason, d.retryStopped, d.inFlight)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted">「送信済み」はLINEが受け付けたことを表します。相手に届いたこと(ブロックされていないことなど)までは確認できません。</p>
        </Card>
      )}
    </div>
  );
}
