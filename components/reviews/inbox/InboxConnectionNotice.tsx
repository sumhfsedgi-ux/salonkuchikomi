import type { ReactNode } from "react";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import { buttonClassName } from "@/components/ui/Button";
import { ExternalLinkIcon } from "@/components/ui/icons";
import LocationPicker from "@/components/reviews/inbox/LocationPicker";
import { ACCOUNT_NOTE, CONSENT_ITEMS, GMAIL_NOTE } from "@/components/reviews/inbox/connectCopy";
import type { ActionResult, GbpConnectionState } from "@/lib/googleReviews/types";

// 届いた口コミの、店舗を選んで使える状態になる前の画面(計画 第2版 §2 操作の流れ 1〜3)。
//   未連携         : 説明と、連携の前の同意 →「Googleと連携する」(予約メールの Gmail と同じアカウントなら権限の追加も選べる)
//   再連携が必要   : 連携中のアカウントで再接続する
//   権限が足りない : 連携中のアカウントに口コミの権限を追加する
//   同意の確認     : 共通の Google 連携の画面から連携した・同意の版が変わった。同意を記録するまで、店舗の候補も取らない
//   店舗の選択     : Google のビジネスの一覧から1つ選ぶ(一覧を取れない・0件・選べるものが無い、も区別して出す)
// どの操作も、共通の Google 連携(lib/google)を使う。予約メール(Gmail)の連携は変えない。

const GOOGLE_BUSINESS_URL = "https://business.google.com/";

interface Props {
  state: Exclude<GbpConnectionState, { kind: "connected" }>;
  /** 予約メールで連携している Google アカウント(あれば。同じアカウントに権限を追加する案内に使う)。 */
  gmailAccountEmail: string | null;
  connect: (formData: FormData) => Promise<void>;
  /** 同意だけを記録する(consent_required のとき)。 */
  agree: (formData: FormData) => Promise<void>;
  stop: (formData: FormData) => Promise<void>;
  select: (input: { locationName: string }) => Promise<ActionResult>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-border bg-ivory p-3 text-xs text-ink-muted">{children}</p>;
}

function ConnectForm({
  connect,
  mode,
  label,
  variant = "primary",
  consentField = false,
}: {
  connect: Props["connect"];
  mode: string;
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  consentField?: boolean;
}) {
  return (
    <form action={connect} className="contents">
      <input type="hidden" name="mode" value={mode} />
      {consentField && <input type="hidden" name="consent" value="yes" />}
      <button type="submit" className={buttonClassName({ variant })}>
        {label}
      </button>
    </form>
  );
}

/** 口コミの取り扱いの説明と、確認のチェック(HTML の required とサーバーの両方で確かめる)。 */
function ConsentBox() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-ivory p-3">
      <p className="text-sm font-semibold text-ink">口コミの取り扱いについて</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-muted">
        {CONSENT_ITEMS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" name="consent" value="yes" required className="mt-0.5 h-5 w-5 shrink-0 accent-sage-dark" />
        上の内容を確認しました
      </label>
    </div>
  );
}

function StopForm({ stop }: { stop: Props["stop"] }) {
  return (
    <form action={stop} className="contents">
      <input type="hidden" name="feature" value="gbp" />
      <button type="submit" className={buttonClassName({ variant: "ghost" })}>
        口コミの連携をやめる
      </button>
    </form>
  );
}

export default function InboxConnectionNotice({ state, gmailAccountEmail, connect, agree, stop, select }: Props) {
  if (state.kind === "not_connected") {
    return (
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-ink">Googleに届いた口コミを、ここで確認・返信できます</h2>
          <p className="text-sm text-ink-muted">
            Googleビジネスプロフィールを管理しているGoogleアカウントと連携し、口コミを受け取る店舗を選んでください。
          </p>
        </div>
        {/* 同意のチェックは、連携を始めるどのボタンにも必要(HTML の required とサーバーの両方で確かめる)。 */}
        <form action={connect} className="flex flex-col gap-4">
          <ConsentBox />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {gmailAccountEmail ? (
              <>
                <button type="submit" name="mode" value="same_account" className={buttonClassName({ variant: "primary" })}>
                  予約メールと同じアカウントで連携する
                </button>
                <button type="submit" name="mode" value="connect" className={buttonClassName({ variant: "secondary" })}>
                  別のGoogleアカウントで連携する
                </button>
              </>
            ) : (
              <button type="submit" name="mode" value="connect" className={buttonClassName({ variant: "primary" })}>
                Googleと連携する
              </button>
            )}
          </div>
          {gmailAccountEmail && (
            <p className="break-words text-xs text-ink-muted">予約メールで連携しているアカウント:{gmailAccountEmail}</p>
          )}
        </form>
        <Note>
          {ACCOUNT_NOTE} {GMAIL_NOTE}
        </Note>
      </Card>
    );
  }

  if (state.kind === "needs_reconnect") {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">Googleとの連携の確認が必要です</h2>
        <p className="text-sm text-ink-muted">
          Googleアカウント{state.googleEmail ? `(${state.googleEmail})` : ""}の許可を確認できませんでした。もう一度Googleで確認してください。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <ConnectForm connect={connect} mode="reauth" label="Googleに再接続する" />
          <StopForm stop={stop} />
        </div>
        <Note>{GMAIL_NOTE}</Note>
      </Card>
    );
  }

  if (state.kind === "scope_missing") {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">口コミの権限が足りません</h2>
        <p className="text-sm text-ink-muted">
          Googleアカウント{state.googleEmail ? `(${state.googleEmail})` : ""}で、口コミを扱う権限が許可されていません。権限を追加してください。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <ConnectForm connect={connect} mode="add_scope" label="権限を追加する" />
          <StopForm stop={stop} />
        </div>
        <Note>{GMAIL_NOTE}</Note>
      </Card>
    );
  }

  if (state.kind === "consent_required") {
    return (
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-ink">口コミの取り扱いについて確認してください</h2>
          <p className="text-sm text-ink-muted">
            Googleアカウント{state.googleEmail ? `(${state.googleEmail})` : ""}と連携しています。確認が済むまで、Googleから店舗や口コミは取得しません。
          </p>
        </div>
        <form action={agree} className="flex flex-col gap-4">
          <ConsentBox />
          <button type="submit" className={`${buttonClassName({ variant: "primary" })} self-start`}>
            確認して、店舗の選択へ進む
          </button>
        </form>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <StopForm stop={stop} />
        </div>
        <Note>{GMAIL_NOTE}</Note>
      </Card>
    );
  }

  // 店舗の選択
  const locations = state.accounts.flatMap((account) => account.locations);
  const selectable = locations.filter((location) => location.unavailableReason === null).length;
  const switchButton = <ConnectForm connect={connect} mode="switch_account" label="別のGoogleアカウントで確認する" variant="secondary" />;
  const googleLink = (
    <a href={GOOGLE_BUSINESS_URL} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "ghost" })}>
      Googleビジネスプロフィールを開く
      <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
    </a>
  );

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-ink">
          {state.loadError
            ? "ビジネスの一覧を取得できませんでした"
            : locations.length === 0
              ? "このGoogleアカウントで管理しているビジネスが見つかりません"
              : selectable === 0
                ? "選べるビジネスがありません"
                : "口コミを受け取るビジネスを選んでください"}
        </h2>
        {state.googleEmail && <p className="break-words text-sm text-ink-muted">Googleアカウント:{state.googleEmail}</p>}
      </div>

      {state.loadError ? (
        <Alert variant="warning">{state.loadError}</Alert>
      ) : locations.length === 0 ? (
        <div className="flex flex-col gap-2 text-sm text-ink">
          <p>このGoogleアカウントがオーナーまたは管理者になっているGoogleビジネスプロフィールが見つかりませんでした。次のような場合があります。</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-muted">
            <li>この店舗のビジネスプロフィールを、別のGoogleアカウントで管理している</li>
            <li>このGoogleアカウントが、ビジネスプロフィールのオーナーまたは管理者に追加されていない</li>
            <li>ビジネスプロフィールをまだ作成していない</li>
          </ul>
        </div>
      ) : (
        <>
          {selectable === 0 && (
            <p className="text-sm text-ink">
              このGoogleアカウントで管理しているビジネスは、どれも下の理由で選べません。別のGoogleアカウントで確認するか、Googleビジネスプロフィールで状態を確認してください。
            </p>
          )}
          <LocationPicker accounts={state.accounts} select={select} />
        </>
      )}

      <Note>{ACCOUNT_NOTE}</Note>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {switchButton}
        {(locations.length === 0 || selectable === 0) && googleLink}
        <StopForm stop={stop} />
      </div>
    </Card>
  );
}
