// Gmail のメールをどの日時から読むか(定期処理が gmail_scan_state を初めて作るとき、
// または予約メールのアカウントが変わったときの基準日時)。
//
// 原則: Google に接続した日時をそのまま取得開始日時にしない(docs/plans/lavi-notification-cutover-plan.md)。
//   - 旧サービスからの切り替え: 運営が照合した範囲の始め(mail_fetch_since)から読む。お客様が再接続する前に
//     届き、旧側でも処理されていないメールも取り込む(旧側で処理済みのものは照合で processed_emails に入れてあり、
//     重複しない)。
//   - 新規店舗の初回開始: 開始した日時(mail_fetch_since = 開始日時。接続した日時ではない)から読む。
//   - 同じアカウントの再認証: アカウントは変わらないので取得開始も変えない(読み進めた位置から続ける。
//     認証が切れていた間のメールは、障害で遅れたものとして24時間以内なら送る)。
//   - 開始後に別のアカウントへ切り替えた: 新しい受信箱の、切り替える前のメールは読まない
//     (切り替えた日時と mail_fetch_since の遅い方から)。
// 意図的に止めていた期間のメールを後から送らないこと・処理済みのメールを重複して送らないことは、
// 送信直前の確認(notifications_begin_send)と processed_emails が受け持つ(ここでは緩めない)。

export type FetchStartReason = "configured" | "account_switched_after_start";

export interface FetchStartInput {
  /** 運用状態の取得開始日時(運営の開始、またはお客様の開始で決めたもの)。 */
  mailFetchSince: Date;
  /** mail_fetch_since を決めたときに予約メールに使っていたアカウント。 */
  mailFetchAccountId: string | null;
  /** 今、予約メールに使っているアカウント。 */
  currentAccountId: string;
  /** 今のアカウントを結び付けた日時(切り替えで更新。再認証では変わらない)。 */
  accountBoundAt: Date;
}

export function resolveFetchStart(input: FetchStartInput): { since: Date; reason: FetchStartReason } {
  // mail_fetch_account_id は開始の関数が必ず記録する(未記録は、開始の関数を通らずに作った行だけ)。
  if (input.mailFetchAccountId === null || input.mailFetchAccountId === input.currentAccountId) {
    return { since: input.mailFetchSince, reason: "configured" };
  }
  const since = input.accountBoundAt > input.mailFetchSince ? input.accountBoundAt : input.mailFetchSince;
  return { since, reason: "account_switched_after_start" };
}
