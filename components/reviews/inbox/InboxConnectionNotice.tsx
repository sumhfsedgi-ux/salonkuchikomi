import type { ReactNode } from "react";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import { buttonClassName } from "@/components/ui/Button";
import { ExternalLinkIcon } from "@/components/ui/icons";
import LocationPicker, { ReloadLocationsButton } from "@/components/reviews/inbox/LocationPicker";
import { ACCOUNT_NOTE, CONSENT_SECTIONS, GMAIL_NOTE } from "@/components/reviews/inbox/connectCopy";
import type { ActionResult, GbpConnectionState } from "@/lib/googleReviews/types";

// 口コミの、店舗を選んで使える状態になる前の画面(計画 第2版 §2 操作の流れ 1〜3)。
//   未接続         : 口コミ機能を使う前の説明と同意 → Google アカウントと接続(予約通知の Gmail と同じアカウントなら権限の追加も選べる)
//   再連携が必要   : 接続中のアカウントで再接続する
//   権限が足りない : 接続中のアカウントに口コミの権限を追加する
//   同意の確認     : 共通の Google 連携の画面から接続した・同意の版が変わった。同意を記録するまで、店舗の候補も取らない
//   店舗の選択     : Google 上の店舗から1つ選ぶ(取得の失敗・0件・選べるものが無い、を区別して出す)
// 「口コミ用Googleアカウントの接続を解除」は、口コミの結び付けを外し、一時保存した口コミ・下書きを削除する
// (stopFeatureAction('gbp'))。予約通知の Gmail の連携は変えない。
// 予約通知の Gmail についての説明は、予約通知の Google 連携がある店舗にだけ出す。

const GOOGLE_BUSINESS_URL = "https://business.google.com/";

interface Props {
  state: Exclude<GbpConnectionState, { kind: "connected" }>;
  /** SalonPack の店舗名(どの店舗への紐付けかを示す)。 */
  salonName: string;
  /** 予約通知の Gmail を連携しているか。 */
  gmailConnected: boolean;
  /** 予約通知で連携している Google アカウント(口コミをまだ接続していないとき。同じアカウントに権限を追加する案内に使う)。 */
  gmailAccountEmail: string | null;
  connect: (formData: FormData) => Promise<void>;
  /** 同意だけを記録する(consent_required のとき)。 */
  agree: (formData: FormData) => Promise<void>;
  stop: (formData: FormData) => Promise<void>;
  select: (input: { locationName: string }) => Promise<ActionResult>;
}

function ConnectForm({
  connect,
  mode,
  label,
  variant = "primary",
}: {
  connect: Props["connect"];
  mode: string;
  label: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <form action={connect} className="contents">
      <input type="hidden" name="mode" value={mode} />
      <button type="submit" className={buttonClassName({ variant })}>
        {label}
      </button>
    </form>
  );
}

/** 口コミの取り扱いの説明と、同意のチェック(HTML の required とサーバーの両方で確かめる)。 */
function ConsentBox() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-ivory p-3">
      {CONSENT_SECTIONS.map((section) => (
        <div key={section.title} className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-ink">{section.title}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-muted">
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" name="consent" value="yes" required className="mt-0.5 h-5 w-5 shrink-0 accent-sage-dark" />
        上記の取り扱いに同意します
      </label>
    </div>
  );
}

/** 口コミ用 Google アカウントの接続の解除(削除を伴うので、内容を開いて確かめてから押す)。 */
function DisconnectForm({ stop, gmailConnected }: { stop: Props["stop"]; gmailConnected: boolean }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-ink-muted">口コミ用Googleアカウントの接続を解除</summary>
      <form action={stop} className="mt-2 flex flex-col gap-2 rounded-lg border border-border p-3">
        <input type="hidden" name="feature" value="gbp" />
        <p className="text-xs text-ink-muted">
          口コミ機能とGoogleアカウントの接続を解除し、一時保存した口コミ・下書きを削除します。Googleに投稿済みの返信は残ります。
          {gmailConnected ? ` ${GMAIL_NOTE}` : ""}
        </p>
        <button type="submit" className={buttonClassName({ variant: "secondary", size: "sm", className: "w-fit text-danger" })}>
          接続を解除する
        </button>
      </form>
    </details>
  );
}

function AccountLine({ email }: { email: string | null }) {
  return email ? <p className="break-words text-sm text-ink-muted">接続中:{email}</p> : null;
}

export default function InboxConnectionNotice({ state, salonName, gmailConnected, gmailAccountEmail, connect, agree, stop, select }: Props) {
  if (state.kind === "not_connected") {
    return (
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-ink">口コミ機能を使う前に</h2>
          <p className="text-sm text-ink-muted">
            Googleビジネスプロフィールを管理しているGoogleアカウントと接続し、連携する店舗を選ぶと、Googleの口コミをここで確認・返信できます。
          </p>
        </div>
        {/* 同意のチェックは、接続を始めるどのボタンにも必要(HTML の required とサーバーの両方で確かめる)。 */}
        <form action={connect} className="flex flex-col gap-4">
          <ConsentBox />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {gmailAccountEmail ? (
              <>
                <button type="submit" name="mode" value="same_account" className={buttonClassName({ variant: "primary" })}>
                  同意して、予約通知と同じアカウントで接続
                </button>
                <button type="submit" name="mode" value="connect" className={buttonClassName({ variant: "secondary" })}>
                  同意して、別のアカウントで接続
                </button>
              </>
            ) : (
              <button type="submit" name="mode" value="connect" className={buttonClassName({ variant: "primary" })}>
                同意してGoogleと接続する
              </button>
            )}
          </div>
          {gmailAccountEmail && (
            <p className="break-words text-xs text-ink-muted">
              予約通知のアカウント:{gmailAccountEmail}。{ACCOUNT_NOTE}
            </p>
          )}
        </form>
      </Card>
    );
  }

  if (state.kind === "needs_reconnect") {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Googleとの再接続が必要です</h2>
        <p className="text-sm text-ink-muted">
          Googleアカウント{state.googleEmail ? `(${state.googleEmail})` : ""}の許可を確認できませんでした。もう一度Googleで許可してください。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <ConnectForm connect={connect} mode="reauth" label="Googleに再接続する" />
        </div>
        <DisconnectForm stop={stop} gmailConnected={gmailConnected} />
      </Card>
    );
  }

  if (state.kind === "scope_missing") {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">口コミの権限が足りません</h2>
        <p className="text-sm text-ink-muted">
          Googleアカウント{state.googleEmail ? `(${state.googleEmail})` : ""}で、口コミを扱う権限が許可されていません。権限を追加してください。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <ConnectForm connect={connect} mode="add_scope" label="権限を追加する" />
        </div>
        <DisconnectForm stop={stop} gmailConnected={gmailConnected} />
      </Card>
    );
  }

  if (state.kind === "consent_required") {
    return (
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-ink">口コミ機能を使う前に</h2>
          <AccountLine email={state.googleEmail} />
          <p className="text-sm text-ink-muted">同意するまで、Googleから店舗や口コミは取得しません。</p>
        </div>
        <form action={agree} className="flex flex-col gap-4">
          <ConsentBox />
          <button type="submit" className={`${buttonClassName({ variant: "primary" })} self-start`}>
            同意して店舗を選ぶ
          </button>
        </form>
        <DisconnectForm stop={stop} gmailConnected={gmailConnected} />
      </Card>
    );
  }

  // 店舗の選択
  const locations = state.accounts.flatMap((account) => account.locations);
  const selectable = locations.filter((location) => location.unavailableReason === null).length;
  const switchButton = <ConnectForm connect={connect} mode="switch_account" label="Googleアカウントを変更する" variant="secondary" />;
  const googleLink = (
    <a href={GOOGLE_BUSINESS_URL} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "ghost" })}>
      Googleの管理画面を開く
      <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
    </a>
  );

  let body: ReactNode;
  if (state.loadError) {
    // 取得の失敗(0件とは区別する)
    body = (
      <>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-ink">店舗の一覧を取得できませんでした</h2>
          <AccountLine email={state.googleEmail} />
        </div>
        <Alert variant="warning">{state.loadError}</Alert>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <ReloadLocationsButton variant="primary" />
          {switchButton}
        </div>
      </>
    );
  } else if (locations.length === 0) {
    // 正しく取得できたが、0件
    body = (
      <>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-ink">連携できる店舗が見つかりませんでした</h2>
          <AccountLine email={state.googleEmail} />
        </div>
        <p className="text-sm text-ink">
          店舗を管理しているGoogleアカウントで接続してください。店舗が表示されない場合は、Google側の管理権限をご確認ください。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {switchButton}
          <ReloadLocationsButton />
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-ink-muted">店舗が見つからない場合</summary>
          <div className="mt-2 flex flex-col gap-2 text-xs text-ink-muted">
            <ul className="flex list-disc flex-col gap-1 pl-5">
              <li>店舗のGoogleビジネスプロフィールを、別のGoogleアカウントで管理している</li>
              <li>このGoogleアカウントが、店舗のオーナーまたは管理者に追加されていない</li>
              <li>Googleビジネスプロフィールをまだ作成していない</li>
            </ul>
            <div>{googleLink}</div>
          </div>
        </details>
        {gmailConnected && <p className="text-xs text-ink-muted">{ACCOUNT_NOTE}</p>}
      </>
    );
  } else {
    body = (
      <>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-ink">{selectable === 0 ? "選べる店舗がありません" : "連携する店舗を選んでください"}</h2>
          <p className="break-words text-sm text-ink-muted">SalonPackの「{salonName}」と連携するGoogle上の店舗を選んでください。</p>
          <AccountLine email={state.googleEmail} />
        </div>
        {selectable === 0 && (
          <p className="text-sm text-ink">どの店舗も、下の理由で今は選べません。理由を解消してから店舗一覧を再読み込みするか、Googleアカウントを変更してください。</p>
        )}
        <LocationPicker accounts={state.accounts} select={select} />
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {switchButton}
          <ReloadLocationsButton />
        </div>
        {gmailConnected && <p className="text-xs text-ink-muted">{ACCOUNT_NOTE}</p>}
      </>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      {body}
      <DisconnectForm stop={stop} gmailConnected={gmailConnected} />
    </Card>
  );
}
