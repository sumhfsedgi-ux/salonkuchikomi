"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import Button, { buttonClassName } from "@/components/ui/Button";
import SupportContact from "@/components/support/SupportContact";
import {
  createInviteAction,
  reissueInviteAction,
  removeRecipientAction,
  revokeInviteAction,
  updateRecipientAction,
  type IssuedInvite,
} from "@/app/dashboard/notifications/recipientActions";
import { LOCKED_SETTING_MESSAGE } from "@/lib/notifications/recipients/messages";
import type { PendingInvite, Recipient } from "@/lib/notifications/recipients/db";
import type { SupportContact as Contact } from "@/lib/support/contact";

// LINE の通知先(スタッフ・オーナー本人)の一覧と追加。
//   - 追加: 表示名を入れて招待(リンクと QR)を作り、スタッフ本人が開いて自分の LINE を連携する(24時間・1人だけ)
//   - 一覧: 表示名(SalonPack の中だけで使う)・接続状態・新規予約/キャンセルの ON/OFF・解除
//   - 切り替え待ちの間、旧サービスから引き継いだ通知先の ON/OFF・解除はできない(DB の判定をそのまま表示に使う)
// 通知先の追加・変更・解除で、予約通知の稼働状態は変わらない。

interface Props {
  recipients: Recipient[];
  invites: PendingInvite[];
  invitesAvailable: boolean;
  supportContact: Contact | null;
}

function formatJst(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function IssuedInviteCard({ invite, onClose }: { invite: IssuedInvite; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-sage/30 bg-sage-soft/40 p-4" data-testid="issued-invite">
      <p className="text-sm font-medium text-ink">「{invite.displayName}」さんへの招待</p>
      <p className="text-xs text-ink-muted">
        このリンクかQRコードをスタッフ本人に渡してください。本人が開いて、LINEで連携します。24時間有効・1人だけ登録できます(期限 {formatJst(invite.expiresAt)})。
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL の QR(外部の画像ではない) */}
        <img src={invite.qrDataUrl} alt="招待のQRコード" width={180} height={180} className="rounded-md border border-border bg-white" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <input readOnly value={invite.url} aria-label="招待のリンク" className="w-full rounded-md border border-border bg-white px-2 py-1.5 text-xs text-ink" onFocus={(e) => e.target.select()} />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(invite.url);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "コピーしました" : "リンクをコピー"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              閉じる
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecipientRow({ recipient, supportContact }: { recipient: Recipient; supportContact: Contact | null }) {
  const router = useRouter();
  const [state, setState] = useState(recipient);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(recipient.label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = state.label ?? "スタッフ";

  async function toggle(patch: { newReservationEnabled?: boolean; cancellationEnabled?: boolean }) {
    const previous = state;
    setState((s) => ({ ...s, ...patch }));
    setError(null);
    const result = await updateRecipientAction(recipient.id, patch);
    if (!result.ok) {
      setState(previous);
      setError(result.error);
    }
  }

  async function saveName() {
    setBusy(true);
    setError(null);
    const result = await updateRecipientAction(recipient.id, { label: name });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setState((s) => ({ ...s, label: name.trim() }));
    setEditing(false);
  }

  async function remove() {
    if (!window.confirm(`「${label}」を通知先から解除します。解除すると、このLINEには予約通知が届かなくなります。よろしいですか?`)) return;
    setBusy(true);
    setError(null);
    const result = await removeRecipientAction(recipient.id);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0" data-testid="recipient-row">
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <div className="flex flex-1 items-center gap-2">
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="表示名" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm" />
            <Button type="button" size="sm" disabled={busy} onClick={saveName}>
              保存
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              やめる
            </Button>
          </div>
        ) : (
          <span className="text-sm font-medium text-ink">
            {label}
            <button type="button" className="ml-2 text-xs text-sage-dark underline underline-offset-2" onClick={() => setEditing(true)}>
              名前を変更
            </button>
          </span>
        )}
        <Badge variant={state.status === "connected" ? "success" : "neutral"} dot>
          {state.status === "connected" ? "連携済み" : "未接続"}
        </Badge>
      </div>
      <label className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm text-ink">新規予約</span>
        <input type="checkbox" className="h-5 w-5 shrink-0 accent-sage-dark" checked={state.newReservationEnabled} disabled={state.changeLocked}
          onChange={(e) => toggle({ newReservationEnabled: e.target.checked })} aria-label={`${label}の新規予約の通知`} />
      </label>
      <label className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm text-ink">キャンセル</span>
        <input type="checkbox" className="h-5 w-5 shrink-0 accent-sage-dark" checked={state.cancellationEnabled} disabled={state.changeLocked}
          onChange={(e) => toggle({ cancellationEnabled: e.target.checked })} aria-label={`${label}のキャンセルの通知`} />
      </label>
      {state.changeLocked ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-ink-muted">{LOCKED_SETTING_MESSAGE}</p>
          <SupportContact contact={supportContact} />
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={remove} className="w-fit text-xs text-danger underline underline-offset-2 disabled:opacity-50">
          通知先から解除
        </button>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}

export default function RecipientsPanel({ recipients, invites, invitesAvailable, supportContact }: Props) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<{ ok: true; invite?: IssuedInvite } | { ok: false; error: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) return setError(result.error);
    if ("invite" in result && result.invite) setIssued(result.invite);
    router.refresh();
  }

  return (
    <Card className="flex flex-col gap-4" id="recipients">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-ink">LINEの通知先</h2>
        <p className="text-xs text-ink-muted">通知先が1人増えるごとに、予約1件あたりのLINEの送信が1件増えます。</p>
      </div>

      {recipients.length === 0 ? (
        <p className="text-sm text-ink-muted">通知先はまだありません。</p>
      ) : (
        <div className="flex flex-col gap-3">
          {recipients.map((r) => (
            <RecipientRow key={`${r.id}:${r.label}:${r.newReservationEnabled}:${r.cancellationEnabled}`} recipient={r} supportContact={supportContact} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        {!invitesAvailable ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-ink">LINEの通知先の追加は準備中です。追加が必要な場合は、運営にお問い合わせください。</p>
            <SupportContact contact={supportContact} />
          </div>
        ) : issued ? (
          <IssuedInviteCard invite={issued} onClose={() => setIssued(null)} />
        ) : adding ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => createInviteAction(displayName)).then(() => {
                setAdding(false);
                setDisplayName("");
              });
            }}
          >
            <label htmlFor="invite-name" className="text-sm text-ink">
              通知先の表示名(例:山田、受付)
            </label>
            <input id="invite-name" value={displayName} maxLength={40} required onChange={(e) => setDisplayName(e.target.value)} className="rounded-md border border-border px-3 py-2 text-sm" />
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

      {invitesAvailable && invites.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-xs font-semibold text-ink-muted">まだ使われていない招待</h3>
          {invites.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="pending-invite">
              <span className="text-sm text-ink">
                {invite.displayName}
                <span className="ml-2 text-xs text-ink-muted">{invite.expired ? "期限切れ" : `期限 ${formatJst(invite.expiresAt)}`}</span>
              </span>
              <span className="flex gap-2">
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => reissueInviteAction(invite.id))}>
                  再発行
                </Button>
                {!invite.expired && (
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => revokeInviteAction(invite.id))}>
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
