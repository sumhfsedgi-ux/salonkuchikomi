# 予約通知の切り替え PLAN(旧サービス hmail → SalonPack)・SalonPack 共通の Google 連携

最終更新: 2026-10-10(branch: `feature/lavi-notification-cutover`、PR #3。本番準備の手順は `docs/plans/lavi-release-runbook.md`)

> **本番の状態(2026-10-10 時点)**: 本番の共有DBに **0020〜0023 を適用済み**。旧側の監視の最小限の権限も付与済み。
> アプリは PR #3 のマージで本番(Vercel の salonpack)にデプロイする。
> **LINE へは1通も送らない状態**(`LINE_REAL_SEND_VERIFY=1`・検証宛先は空)で、予約通知の定期ジョブも作っていない。Google 接続の条件(手順書の段階3)は未完了。
> 旧サービス(hmail)は Lavi・ayana の両方で今も通知中で、停止・設定変更はしていない。§5 の ⓪〜⑤ は、まだ実行していない。
> **0021〜0023 は本番適用済みのため、以後は直接書き換えない**(DB の修正は新しい migration で行う)。

## 0. 確定した方針

1. 既存のお客様には SalonPack で Google へ**再接続**してもらう。hmail の Gmail 認証トークンは移行しない。migration-bridge は今回の切り替えに使わない(廃止)。
2. 「予約通知だけ / 届いた口コミだけ / 両方」に対応する。機能は固定の3択ではなく、契約上使える機能から複数選ぶ(`lib/features/registry.ts`)。
3. 同じ Google アカウントで複数の機能を使う店舗は、1回の連携で必要な権限(`gmail.readonly` / `business.manage`)をまとめて要求する。別アカウントなら機能ごとに連携する。
4. 同意を求めるのは初回だけ。保存した認証情報でアクセストークンを自動更新する。権限の追加・認可の失効のときだけ再接続を求める。
5. LINE の送信先は予約通知と口コミ通知で共用する。旧サービスの送信先・個人の設定は id を変えずに引き継ぎ、スタッフに再登録を求めない。口コミだけのお客様に LINE を必須にしない。
6. hmail と SalonPack の二重通知を防ぐ。**Google に接続しただけでは、新側の予約通知は始まらない。**
7. **Lavi Aromatic Herb を先に切り替え、ayana は旧側(hmail)で継続する**(ayana の切り替えは後日、同じ手順で別に行う)。

## 1. 履歴(実施済みの作業。これからの手順とは別)

- **0020 を本番の共有DBへ適用済み**(2026-10-08、お客様が SQL Editor で実行)。`notification_deliveries` 等。0020 は書き換えない。
- **2026-10-10 の本番適用**(運営が実行。手順書の段階1)。0020〜0023 は以後書き換えない。
  - **旧側の監視の権限**: `docs/plans/sql/hmail-legacy-watch-grant.sql` の2文を付与した。前後の確認 [A]〜[D] はすべて期待どおり。
  - **本番 DB**: コミット 27649c9 の 0021 → 0022 → 0023 を順に適用した。すべて成功し、対象の表があることも確認した。
  - **LINE ログインチャネル**: hmail と同じプロバイダーに作成・公開した。既存の公式アカウントをリンクした。
    - コールバック URL は `https://salonpack-salontokyo.vercel.app/api/line/login/callback`。
    - 既存の Messaging API チャネル(Webhook・シークレット・アクセストークン)は変えていない。
  - **Vercel(salonpack)の Production の環境変数**:
    - 設定: `LINE_LOGIN_CHANNEL_ID`・`LINE_LOGIN_CHANNEL_SECRET`・`LINE_RECIPIENT_INVITES_ENABLED=1`・`NEXT_PUBLIC_APP_URL=https://salonpack-salontokyo.vercel.app`・`GOOGLE_TOKEN_KEYS`・`GOOGLE_TOKEN_KEY_CURRENT`・`NOTIFICATIONS_CRON_SECRET`
    - 実機確認のあいだは送らない: `LINE_REAL_SEND_VERIFY=1`、`LINE_REAL_SEND_VERIFY_DESTINATIONS` は無し
    - 既存の値: `LINE_CHANNEL_ACCESS_TOKEN`(再発行していない)
    - 未設定: `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`(段階3)、問い合わせ先(保留)、擬似・検証用 DB の設定
  - **アプリ**: PR #3 で master(アンケート画面の2ステップ化・口コミ生成の待ち時間の改善)を取り込み、master にマージした → GitHub 連携で本番に自動デプロイ。
    - 予約通知の定期ジョブ(cron-job.org)は作っていない。
    - hmail の停止・設定変更、Lavi・ayana の新側での開始、お客様への再接続の依頼は、していない。
- **hmail の migration-bridge**: `chore/temp-migration-bridge` を Vercel の Preview にデプロイし、Preview 限定の環境変数4つを設定して dry-run の疎通まで確認した。**この方式は廃止**。ローカルでは、未commitだった route.ts の変更を `docs/plans/history/hmail-migration-bridge-uncommitted-2026-10-08.patch` に保存してから、そのファイルだけ元に戻し、秘密値の控え(`hmail/.env.migration-bridge.local`)を削除した。外部に残る片付けは §10。
- **フェーズ0(Lavi の旧側のスタッフ行の確認。読み取りのみ)**: hmail の salon 行3件(予約受信用 Gmail は全員 `<Laviの予約受信用Gmail>`、全員 `connected`):
  `30a76230-e8c3-4c6e-99eb-509e5d6d795a`(onboarding 未完了)、`6d68e9ce-2db8-45d4-b8d1-a656780c6f8e`(LaviAromaticHerb)、`eff51657-fa3f-4d4e-98d8-a3dae38a1de3`。
  トークンを移行しないため、「代表1件」の選定は不要になった。**停止・照合はスタッフ全員(3件)が対象。** この3件は、⓪ の対応表の登録と静的移行で、受信用 Gmail から見つかる行と一致することを改めて確かめる(この一覧を手で写して使わない)。
- **教訓**: `KEY=VALUE` のファイルをシェルの `IFS='=' read` で読むと、base64 の末尾の `=` が欠ける(Preview の環境変数で発生・修正済み)。`cut -d= -f2-` 等を使う。
- それ以前に直した配信の不具合7件(同時再送・retry key・本文取得の一時失敗・複数スタッフ途中停止・結果保存失敗・25件超・設定の OR 統合)は、今回の作り直しでもすべて維持し、テストを処理権付きの新しい関数に合わせて書き直した(§9)。

## 2. 変更の選別(4分類。一括の reset/restore/clean は使っていない)

| 分類 | review-app | hmail |
|---|---|---|
| 維持して改善 | `lib/notifications/db/notificationDeliveries.ts`(処理権付きの取り出し・送信直前確認・結果記録へ)、`db/processedEmails.ts`(再クレームに回数上限・締切での解除)、`db/notificationHistory.ts`、`db/lineConnections.ts`(分類不明でも全OFFを迂回しない)、`jobs/pollMailForSalon.ts`・`jobs/pollMailForAllSalons.ts`(運用状態・締切・店舗ごとの持ち時間)、`line/LineClient.ts`(409 の確認・429・受付ID・応答待ちの上限)、`mail/GmailProvider.ts`・`gmailSearchQuery.ts`(ページ単位・受信日時・タイムアウト)、`app/dashboard/notifications/*`、`components/notifications/*`、`scripts/migrate-hmail-notifications.ts`(静的移行だけに。bridge の記述を削除)、`scripts/migrateHmailSettingsFold.ts`、`scripts/testdb/*`、`app/api/cron/notifications/poll-mail/route.ts`、`package.json` | — |
| 新しい仕組みに置き換え | `lib/notifications/mail/google-oauth.ts` → `lib/google/*`、`lib/notifications/db/mailConnections.ts`(+ `lib/notifications/crypto.ts`)→ `google_accounts`・`salon_google_bindings`(0021)、`ConnectionStatusCards`(Gmail 1枚 → 機能ごとの状態)、ホームの初期設定(口コミ専用ウィザード → 機能の選択 + 未設定の項目の案内) | — |
| 不要なので廃止(削除済み) | `app/api/notifications/google/{start,callback}`(Gmail 専用の OAuth、cookie の state)、`upsertMailConnection`、`lib/notifications/jobs/retrySweep.ts`、`.env.example` の hmail クライアント流用・`NOTIFICATIONS_ENCRYPTION_KEY`・`LINE_CHANNEL_SECRET`・`LINE_OA_BASIC_ID` の記述、testdb の `MIGRATION_BRIDGE_SECRET` | migration-bridge(`chore/temp-migration-bridge` のコミット d718c64・3cc455a は**ブランチに残っている**。HEAD に戻しても bridge は残るため、ブランチの削除は承認後に手作業。main は未変更) |
| 本番適用済みのため履歴として保持 | `supabase/migrations/0020_notification_deliveries.sql`(書き換えない。'migrating' の値と旧関数は使わない) | — |

## 3. 5つの層を分けて管理する

| 層 | 正のデータ | 変更できる人 |
|---|---|---|
| 契約上の利用権限 | `salons.plan` × APP_MODE(`lib/access/plan.ts`) | 運営だけ(`scripts/salon-contract.ts`、`salon_plan_changes` に記録) |
| お客様が選んだ機能 | `salon_feature_selections`(+ `salon_setup_state.feature_selection_saved_at`) | お客様(Server Action が契約の範囲か確認) |
| 各機能の設定完了 | データから判定(`lib/features/featureState.ts`) | — |
| 外部サービスの接続・許可 | `google_accounts`(アカウント単位の認証状態)+ `salon_google_bindings`(店舗×機能。その機能だけの権限不足 `scope_missing_since` もここ)+ 許可が確認できた scope | OAuth のコールバック・解除・失敗の分類 |
| 実際の稼働状態 | `reservation_notification_operations` + `reservation_stop_intervals` | 新規店舗のお客様の開始 / 運営 CLI / システム(監視) |

画面・Server Action・API・定期処理は同じ判定を使う。予約通知の定期処理は、稼働中・機能を選択済み・契約が予約通知を含む・全体スイッチ ON・Gmail の権限が確認できたアカウント、の店舗だけを読む(DB 関数 `notifications_list_pollable_salons`)。

## 4. 旧側のスタッフ行と新側の店舗の対応(対応表)

- 旧側(hmail)の「店舗」は、**予約メールを受け取っている Gmail**(`hmail.mail_connections.email_address`)で見つける。ログイン用のメールアドレスは使わない。スタッフ1人 = hmail の salon 行1件(それぞれが同じ受信箱に OAuth している)。
- 新側の店舗(`salons.id`)は、**Gmail アドレスから推定しない**。運営がお客様・契約を確かめて、対応表 `legacy_salon_mappings`(新側の店舗 ↔ 予約受信用 Gmail ↔ スタッフの人数)に登録したものだけを使う。1つの受信用 Gmail は1店舗にだけ対応させる。比較は小文字・前後の空白を除き、gmail.com はドットと `+` 以降を無視する(Gmail では同じ受信箱)。
- 静的移行は、指定したスタッフの id の集合が「対応表の受信用 Gmail で見つかる旧側の行」と完全に一致し、人数が対応表と同じときだけ書き込む。**1人の指定漏れ・他店舗(例: ayana)の id・存在しない id・別の店舗へ移行済みの id・人数の不一致は、書き込む前に拒否する**(CLI の確認 + 同じトランザクションでの再確認 + DB 関数 `reservation_ops_mark_legacy` の最後の防御。旧側の1行は2つの店舗に登録できない一意索引あり)。
- 登録のあとに、同じ受信用 Gmail の旧側の行が**増えた**・登録した行が**無くなった**・**別の受信箱に変わった**・人数が合わない場合は、旧側の確認(`reservation_ops_legacy_check`)が「確認できない」を返し、**旧側の停止・停止確認・照合・開始・送信直前の監視のすべてで止まる**(稼働中なら自動で停止)。確認できないものは始めない。
- 開始のとき、お客様が SalonPack で連携した予約メールの Google アカウントが、対応表の受信用 Gmail と同じであることも DB で確かめる(別のアカウントで連携していたら開始を拒否)。
- お客様の実際のメールアドレスは、このリポジトリ(計画書・テスト)に書かない。手順では `<Laviの予約受信用Gmail>` のように書き、実際の値は運営が確認した対応表(リポジトリの外)から CLI の引数で渡す。

## 5. これからの手順(Lavi を先に切り替え、ayana は旧側で継続)

すべて運営の作業。CLI は既定で確認だけ(`--apply` で書き込み、旧側への書き込みはさらに `--approve-hmail-write`)。接続先は `review-app/.env.hmail-migration.local` の `DATABASE_URL`(Supabase の直接接続文字列。値はチャットに貼らない)。

**⓪ 準備**(§10 の外部設定・本番への 0021/0022/0023 の適用・アプリのデプロイ・運営自身の LINE での実機確認・Google 接続の条件の確認が終わってから。順番は `docs/plans/lavi-release-runbook.md`)
1. 新側の Lavi の店舗(`salons.id`)を、お客様のアカウント・契約から確かめる(以前の作業で控えた候補 `fc10f5d5-39a1-4210-b544-d23a3e402e42` も、ここで確かめ直す。Gmail アドレスでは決めない)。契約が予約通知を含むこと(`scripts/salon-contract.ts show`)。
2. 対応表への登録(まず確認だけ。移行先の店舗名・旧側で見つかったスタッフ・人数が表示される):
   ```
   npx tsx scripts/reservation-notifications-ops.ts map --salon-id=<Laviのsalons.id> --mailbox=<Laviの予約受信用Gmail> --expected-staff=3 --by=<名前>
   # 3人(30a76230… / 6d68e9ce… / eff51657…)と表示されることを確かめてから --apply
   ```
   見つかった人数が3人でなければ登録されない(何が増えた・減ったかを確かめる)。
3. 静的移行(まず確認だけ):
   ```
   npx tsx scripts/migrate-hmail-notifications.ts --hmail-salon-ids=30a76230-e8c3-4c6e-99eb-509e5d6d795a,6d68e9ce-2db8-45d4-b8d1-a656780c6f8e,eff51657-fa3f-4d4e-98d8-a3dae38a1de3 --target-salon-id=<Laviのsalons.id> --by=<名前>
   # 「✓ スタッフ 3 人 = 予約受信用 Gmail の旧側のスタッフ全員」と、スタッフごとの設定を確認してから --apply
   ```
   送信先・個人の設定を移し、予約通知を選択済みにし、**切り替え待ち**として登録する(スタッフごとの旧側の接続状態を控える)。必ずお客様に再接続を依頼する**前**に行う。
4. ayana の行は登録しない(対応表にも静的移行にも入れない)。ayana の id を混ぜると拒否される。

**① お客様の再接続**: Lavi のお客様が `/dashboard/settings/google` で、**予約メールが届く Gmail(<Laviの予約受信用Gmail>)** の Google アカウントで連携する。新側は切り替え待ちのまま、旧側は通知を続ける。運営は連絡を待たずに確認できる:
```
npx tsx scripts/reservation-notifications-ops.ts list --awaiting
# Google: 再接続済み 初回=… 最終=… アカウント=… Gmail権限=あり / 旧側停止確認=— / 照合=— / 開始=—
# 旧側の予約受信用Gmail=<Laviの予約受信用Gmail> 接続アカウントと一致 旧側の確認=active(legacy_rows_active)
```
「不一致」なら、お客様に正しいアカウントでの連携(「別のGoogleアカウントに切り替える」)をお願いする。接続日時はメール取得開始日時・通知開始日時に使わない。`check-legacy --salon-id=…` で、旧側のスタッフの集合が登録時のままかを確かめられる。

**② 旧側の停止(Lavi のスタッフ全員だけ)**
1. cron-job.org の hmail のジョブを一時停止し、その時刻を控える。**ジョブは全店舗共通のため、ayana の通知もこの間は止まる**(hmail は直近3日のメールを読むので、短時間の停止なら再開後に遅れて届く。失われはしない)。予約の少ない時間帯に行い、停止はできるだけ短くする。
2. 停止前に始まって終了の記録が無い処理があれば、hmail の Vercel の関数ログで終了を確認する(時間の経過だけでは確認済みにしない)。
3. `stop-legacy --salon-id=<Lavi> --cron-paused-at=<控えた時刻> [--attest-run-ended=<run id>] --apply --approve-hmail-write`
   Lavi のスタッフ3人分の `hmail.mail_connections.status` だけを `migrated_to_salonpack` にする(**ayana の行には触れない**。削除・Google の取り消しはしない。cron を止めている間に変えるので、実行中の処理が書き戻すことはない)。旧側のスタッフの集合が登録時と違えば止めない。
4. cron-job.org のジョブを再開し、その時刻を控える(ayana は通常どおり旧側で通知される)。
5. `confirm-cutover --salon-id=<Lavi> --cron-paused-at=… --cron-resumed-at=… --apply --by=…`
   次をすべて確認できたときだけ記録する: 一時停止の間に新しい処理が始まっていない / 停止前の処理が終わっている(または終了を確認済み)/ 再開後に最後まで終わった処理がある / 監視の結果が「止まっている」(Lavi の受信用 Gmail の行が全員止まっていて、集合も登録時のまま。権限が無い・確認できない場合は失敗)/ 停止後に旧側で Lavi のメールが処理されていない。ayana の行が動いていることは、Lavi の確認に影響しない。

**③ 送信状態の照合(メール×スタッフ)**
```
reconcile --salon-id=<Lavi> --window-from=<再接続の24時間前など> --apply --by=…
status --salon-id=<Lavi>        # 確認待ちの一覧
resolve --delivery-id=… --as=sent|skipped|send_now|retry_same_key|manual_resend --reason=… --apply --by=…
reconcile …(もう一度)→ accept-reconciliation --run-id=… --by=…
```
- 対象は Lavi のスタッフ3人の旧側の記録だけ(ayana の記録は含めない)。
- 旧側の状態の対応: 処理していない→引き継ぎ / 送信済み→送信済み(旧側)/ 設定OFF・LINE未連携→送らない / それ以外の失敗・クレーム済みで履歴なし→**確認待ち**(未送信として扱わない)。
- 一部のスタッフだけ処理済みのメールは、新側で分類し直して、未送信のスタッフにだけ配信する(検索の範囲に依存しない)。24時間を過ぎた引き継ぎは確認待ちにする。
- `retry_same_key`: 最初の送信から23時間以内だけ(同じキーなので重複しない)。`manual_resend`: 新しいキーで別の配信行を作る。元が受け付け済みなら**重複する**ため `--accept-duplicate-risk` と理由が必要。結果不明を新しいキーで自動的に解決しない。
- 照合結果は停止確認より後で、未解決ゼロのときだけ受け入れられる。

**④ 開始**: `activate --salon-id=<Lavi> --apply --by=…`(まず確認だけで、接続アカウントと受信用 Gmail の一致・取得開始日時を表示)。メール取得開始は受け入れた照合の範囲の始め(`--window-from`)。**お客様が再接続した日時ではない**ので、再接続より前に届いて旧側でも処理されていないメールも取り込む(旧側で処理済みのものは照合で記録済みのため重複しない)。DB のトリガーが、停止確認・照合の受け入れ・未解決ゼロ・照合の範囲より前から読まないこと・接続アカウント = 受信用 Gmail・監視「止まっている」(集合の一致を含む)を確かめ、満たさなければ拒否する。

**⑤ 確認**: 実際の新規予約とキャンセルで、Lavi の対象のスタッフに1回ずつ届くことを `notification_deliveries`(origin=salonpack・status=sent・line_request_id あり)で確認する。HTTP 200 だけで判断しない。「テスト通知」は LINE との接続の確認だけ。ayana は旧側で通知が続いていることを確かめる。

稼働中も、Lavi の旧側の行が再び処理対象に戻ったら、または確認できなくなったら(同じ受信用 Gmail の行が増えた等)、新側は自動で停止する(`legacy_active`)。

**ayana の切り替え(後日)**: 同じ手順を ayana(予約受信用 Gmail `<ayanaの予約受信用Gmail>`)について、別の日に行う。そのときまで ayana の行は対応表にも静的移行にも入れない。

## 6. 切り戻し

- **A(新側がまだ一度も送信を試みていない)**: `rollback --mode=A --apply --approve-hmail-write` 新側を止め、スタッフごとに**控えた元の状態**へ戻す(全員を無条件に connected にしない)。
- **B(新側が送信を試みた)**: 単純に旧側を再開しない。`rollback --mode=B`(まず確認だけ)でメール×スタッフごとに:
  送信済み・送らないと決めた組 → 旧側のそのスタッフの `processed_emails` に登録(旧側から再送させない)/ 一度も試みていない組 → 登録しない(旧側が送る)/ 結果不明・確認待ちがあるスタッフ → 旧側の再開を保留。メール全体を一律に処理済みにしない。`--apply --approve-hmail-write` で実行(旧側への書き込みのため、その場での承認が必要)。
- どちらも対象は登録した店舗のスタッフの行だけ(ayana の行には触れない)。運用状態を「切り替え待ち」に戻し、停止確認・照合を消す(もう一度切り替えるときはやり直す。開始で取得開始日時を決め直すと、読み進めた位置もそこからやり直す)。

## 7. メールの取得開始日時と遅延通知のルール

**取得開始日時**(`lib/notifications/mail/fetchStart.ts`。接続日時で切り詰めない):

| 場面 | どこから読むか |
|---|---|
| 旧サービスからの切り替え | 照合の範囲の始め(運営の開始で記録。再接続より前の未処理メールも取り込む) |
| 新規店舗の初回開始 | お客様が「開始」を押した日時(接続した日時ではない) |
| 同じアカウントの再認証 | 変えない(読み進めた位置から続ける。認証切れの間のメールは障害扱い) |
| 開始後に別のアカウントへ切り替え | 切り替えた日時(新しい受信箱の、切り替える前のメールは読まない) |

開始のときに使っていたアカウントを `mail_fetch_account_id` に記録し、今のアカウントと違うときだけ「切り替え」として扱う。

**遅延通知のルール**(送信直前に DB で判定。初回の送信のときだけ):

| 予約メールが届いたとき | 扱い |
|---|---|
| 機能OFF・全体スイッチOFF・運営の停止・契約外・旧側の再稼働検知の間 | 送らない(再開しても、まとめて送らない。年齢に関係なく) |
| それ以外(障害・認証切れ・Gmail の権限不足・cron 停止で遅れた) | 受信から24時間以内なら送る。超えたら送らない(理由を記録) |
| 取得開始日時より前 | 送らない |
| 旧サービスからの引き継ぎで24時間超 | 確認待ち |

送信を試みたことがある配信(結果不明など)は、このルールで未送信・解決済みに書き換えない。最初の送信から24時間(retry key の有効期間)を過ぎた結果不明は自動では再送しない。処理済みのメール(`processed_emails`)は重複して処理しない。

## 8. 定期処理の実行時間・Gmail の権限不足

**実行時間**(`lib/notifications/jobs/runBudget.ts`): 関数の上限(maxDuration 60秒)の内側の締切(45秒)までに、新しい処理を始めるのをやめる。
- Gmail・LINE の呼び出しのタイムアウトは、締切までの残り時間(記録の時間を残す)に収まる長さに縮める。下限も収まらなければ始めない。
- メールは1通ずつ「クレーム → 本文 → 分類と配信行」の順に進め、時間が足りなければ次をクレームしない(先にまとめて確保しない)。締切で本文の取得を打ち切ったメールは、試行回数に数えずにクレームを戻す。手を付けていないメール・配信は失敗にしない(次の回へ)。
- 店舗は「最後に処理を始めた日時」の古い順。残り時間を残りの店舗数で分け、1店舗の大量の未処理が後ろの店舗を止めない。時間が足りずに回せなかった店舗は失敗にせず、次の回の先頭になる(`cron_runs.notes` に `deferred_for_time:N`)。
- 送信を始めてから強制終了した配信は、処理権の期限のあと「結果不明」になり、同じ retry key で送り直す(LINE 側で重複しない)。
- DB への問い合わせは、1回10秒の上限に加えて、**全体の残り時間で打ち切る**(`lib/notifications/dbTimeLimit.ts` → `lib/notifications/admin.ts`)。締切(45秒)とは別に上限(57秒 = maxDuration 60秒 − 応答の余裕)を持ち、締切のあとは、始めていた処理の結果の記録と後片付けだけを上限までに行う。
- **DB の応答が遅れても、締切のあとに LINE 送信を始めない**(以前は、38秒に取り出しを始め、取り出し9秒・送信直前の確認9秒で56秒に送信し、記録まで77秒になり得た):
  - 送信前の問い合わせ(取り出し・送信直前の確認)は、「LINE の最短タイムアウト + 記録の余裕」を残した時間で打ち切る。
  - 応答のあとにも残り時間を確かめ直し、足りなければ LINE を呼ばない。まだ送っていないので**未送信と断定して戻す**(取り出しのあと: `notifications_release_claim`、送信直前の確認のあと: `notifications_cancel_send_start`。この確認で付けた最初の送信日時と試行回数も戻す)。
  - 問い合わせが打ち切られた(DB に反映されたか分からない)場合や、戻す問い合わせが失敗した場合は、LINE を呼ばずに止める。処理権の期限のあと**結果不明**として、同じ retry key で再試行する(未送信と断定できないものを、未送信・skipped に書き換えない)。
  - 送信のあとの結果の記録は上限までに行う。履歴(`notification_history`。画面用)は締切を過ぎたら省く(正しい記録は `notification_deliveries`)。

**Gmail の権限不足と認証の失敗の分離**:
- トークンの更新で `invalid_grant`(認可そのものの失効)→ アカウント単位で数え、連続2回で「再接続が必要」。同じアカウントの予約メール・口コミの両方が再接続の対象(共通の再認証)。
- Gmail の API の `insufficient_scope`・トークンの更新の応答に Gmail の権限が無い → **その店舗の予約メールの結び付けだけ**に記録(`scope_missing_since`、停止期間 `gmail_scope`、お客様へ「権限を追加する」の連絡を1回)。アカウントの失敗回数・状態は変えない(同じアカウントの口コミは「許可済み」のまま)。Gmail を読めるようになったら自動で記録を消す。

## 8.1 お客様向けの表示(旧サービスからの切り替えは運営の作業なので、内部の状態を見せない)

- **内部の状態は見せない**:「切り替え待ち」「旧側停止」「照合」は、運営の情報(CLI の `list`・DB)として残す。お客様の画面には出さない(`lib/features/featureState.ts`)。
- **再接続した既存店舗**: 必要な権限で再接続したら「設定完了」と表示する。文は「Googleとの連携が完了しました。お客様の操作は以上です。LINEの再登録は不要です。」。
  - ホームの「設定が必要な項目」で繰り返し案内しない。
  - 開始ボタンは出さない(開始・旧側の停止確認・照合・監視は、運営の手順のまま)。
- **「稼働中」は実際に通知しているときだけ**: 新側が実際に通知していない間は「稼働中」「通知中」と出さない(全体スイッチのバッジは ON/OFF)。
  - 停止が確定している状態(お客様の OFF・運営の停止)と、動作を確認できない状態(監視による停止、予約メールの確認が15分以上途絶えた)を分ける。
  - 旧側が通知を続けているとは断定しない。
  - 権限不足や、新規店舗で通知先が無い場合は、それぞれの案内を出す。
- **切り替え待ちの間は変更を受け付けない**: 全体スイッチと、旧側で使われている既存の通知先の ON/OFF・解除(旧側に反映されないため)。
  - 判定は表示名ではなく移行の記録(`legacy_cutover_snapshots`・`migrated_from_hmail_salon_id`)で行う。画面・Server Action・DB が同じ SQL 関数(`line_recipient_change_locked`)を使う。
  - 新しく追加した通知先の解除と、招待の取消はできる。
- **問い合わせ先**: `NEXT_PUBLIC_SUPPORT_CONTACT_URL` を設定したときだけリンクを出す(未設定なら文言だけ。架空の連絡先は作らない)。

## 8.2 LINE 通知先の追加(オーナーが招待 → スタッフ本人が LINE で連携)

- **既存の本番を守る**:
  - hmail の LINE 公式アカウント(Messaging API チャネル)の Webhook URL・トークンは、使わない・変えない。
  - hmail の Webhook は、コード以外のトークに「コードが見つかりませんでした」と返信する。そのため、スタッフにトークを送らせない。
  - 本人確認は、同じプロバイダーに新しく作る **LINE ログインチャネル**で行う(LINE 公式: "If the provider is the same, the user ID is the same regardless of the channel type (LINE Login channel or Messaging API channel).")。
  - **チャネルを作成・設定するまでは未有効化**。通知先の追加は「運営にお問い合わせください」の案内になる。既存の通知先の一覧・ON/OFF・解除は使える。
- **流れ**:
  1. オーナーが表示名を入れて招待を作る(リンクと QR。24時間・1人だけ)。
  2. スタッフ本人がリンクを開き、店舗名と「予約の情報がLINEに届く」ことを確認する(SalonPack のアカウント・ログインは不要。管理画面の権限は与えない)。
  3. LINE ログイン(友だち追加の案内付き)。
  4. サーバーで ID トークンを検証し、友だち状態を確かめて、通知先に追加する。ブラウザから送られた LINE のユーザー ID は使わない。
- **招待の値**:
  - 推測できない乱数。DB には sha256 だけを保存し、ログには出さない。
  - リンクは `/line/invite#<値>`。フラグメントはリクエストに含まれないので、アクセスログ・Referer に残らない。
  - ページで読み取って POST で一度だけ送り、アドレスバーから消す。
- **戻りと再試行**:
  - ブラウザとの結び付け(httpOnly の cookie。DB にはハッシュ)と、招待1件 × ブラウザ1つの「進行」を記録する。
  - **表示した招待に結び付ける**: 招待を開いた画面は、その進行の id を持つ(アドレスは `/line/invite?f=<id>`)。連携の開始(フォームで id を送る)・state・コールバック・結果ページ(`/line/invite/continue?f=<id>`)・再試行・再読み込みは、すべてこの id で同じ招待を扱う。**ブラウザ全体の「最新の招待」では選ばない**(以前の版は選んでいたため、A店の招待を開いたあと別のタブで B店の招待を開くと、A の画面のボタンで B の連携が始まった)。
  - 画面・URL から来た id は、DB の関数で cookie との対応・期限・招待の状態・登録済みでないことを確かめてから使う(`line_flow_get`・`line_login_create_state`)。別のブラウザ・改ざんした id では、表示も state の作成もしない。
  - LINE からの戻りは固定のページへ。任意の戻り先は受け付けず、URL に結果を載せない(進行の id と案内の種類だけ)。結果ページは、サーバーの記録(登録した通知先の店舗名)だけを表示する。
  - 期限切れ・使用済みの state で戻ったときは、このブラウザの state なら同じ招待の結果ページへ戻す(`line_login_state_flow`)。別のブラウザなら、最初に開いたブラウザでのやり直しを案内する。
  - 登録が済んだ進行の結果は、同じ招待の別のタブのキャンセル・失敗で上書きしない。
  - キャンセル・友だち未追加・途中の通信の失敗では招待を失効させず、同じ画面から再試行できる。
  - state は1回限り・10分。nonce はハッシュで保存し、検証の結果の nonce をハッシュにして照合する。
  - 制約: 初めて招待を開くブラウザで、2つの招待をほぼ同時に開くと、cookie の発行が競合して片方の画面から始められないことがある(安全側。届いたリンクを開き直せば続けられる)。
- **整合**:
  - 招待の使用済みと通知先の登録は、1つのトランザクション(`line_invite_redeem`)で行う。同じ招待を同時に使っても、登録されるのは1人だけ。
  - 同じ店舗・同じ LINE の宛先は「登録済み」として案内し、上書きしない(招待も使わない)。
  - 他の店舗の通知先・招待は変更できない。
  - 通知先の追加・解除は LINE の送信先だけを変え、運用状態・Google 連携・契約・旧側の切り替え状態に触れない(切り替え待ちの店舗は稼働しない)。
  - 完了の表示で「通知開始」とは書かない。
- **解除と再登録**:
  - 解除しても行は残す(配信の記録・世代のため)。再登録では同じ行を戻して、登録の世代を進める。
  - 配信は作成時の世代を持つ。世代が違う配信や、解除済みの通知先には送らない。
  - 送信を一度も始めていない配信は skipped にする。送信を試みた配信は状態を変えずに、再試行だけを止める(送信を始めていた通信は取り消せない)。
  - 登録より前に届いたメールは、その通知先へは送らない。
  - 口コミ通知(口コミブランチの表)は、解除・再登録で OFF にし、勝手に ON にしない。
- **送信数の案内**: 通知先の人数分だけ送信が増えることを、設定画面で案内する。

## 8.3 LINE の実送信は本番だけ(開発・擬似・テスト用DBでは送らない)

- 判定は `lib/notifications/line/sendPolicy.ts` の1か所。送信の入口(`pushText`)・テスト通知の Server Action・画面が同じ判定を使う。
  - **live(実際に送る)**: 本番ビルドで、`SALONPACK_VERIFY_MODE`・擬似 Google / LINE ログインの設定がなく、Vercel のプレビューでもないとき。
  - **simulated(送らない)**: 開発(`next dev`)・テスト用DB・擬似の設定がある・Vercel のプレビュー(`VERCEL_ENV` が production 以外)。実送信用のトークンが誤って設定されていても、`pushText` はクライアントを作る前・HTTP の前に止める。
  - **verify(実機確認の「指定宛先へのテスト送信」用)**: `LINE_REAL_SEND_VERIFY=1` を明示的に設定したときだけ、`LINE_REAL_SEND_VERIFY_DESTINATIONS` に指定した宛先にだけ送る。ほかの宛先には、どの環境でも送らない。
  - **優先順位**: テスト用DB(`SALONPACK_VERIFY_MODE`)・擬似 Google・擬似 LINE ログインの「送らない」 → 検証のフラグ → 開発・プレビューの「送らない」 → 本番。testdb・擬似の環境では、検証のフラグと宛先を設定しても送らない(testdb の開発サーバーは、検証のフラグも無効の値で上書きする)。
- 予約通知の定期処理で送信が止められた配信は、LINE を呼んでいないので未送信と断定して戻す(pending のまま。初回の試行の印も付けない)。
- テスト通知:
  - 本番: 押す前に「登録済みの通知先(◯人)のLINEに、実際にテストメッセージを送ります。」と表示し、本文つきの確認を挟んでから送る(予約通知の開始とは別の操作のまま)。
  - 本番以外: 押す前に「この環境では、LINEへは実際には送信しません」と表示し、結果は「送信をシミュレーションしました（実際には送信していません）」。HTTP も履歴の記録もしない。

## 9. 検証(テスト用DB + 擬似Google・モックだけ。本物の Google・LINE への通信なし)

- `npm test`: 32ファイル・407件 pass(実送信の判定と、擬似環境で送信の HTTP が一度も呼ばれないことを含む)。
- `npm run test:testdb`(実 Postgres・複数接続): 8ファイル・91件 pass(配信の処理権・停止との競合・遅延ルール ほか / 共通 Google 認証 / 機能の選択 / 切り替えの通し(対応表・スタッフの集合の検証・Lavi を先に切り替えて ayana の行に触れない・取得開始日時の回帰)/ Gmail の権限不足の分離 / 実行時間の管理 / 通知先の招待(別のタブの招待と取り違えない・並行して逆順に戻る・片方のキャンセルと再試行・再読み込み・改ざんと別ブラウザの拒否)/ 本番以外で定期処理が送信を止め、配信を未送信のまま戻す)。
- `npm run testdb:walkthrough`(サーバーで描画した HTML と OAuth のリダイレクトを HTTP でたどる)と、`npm run testdb:browser`(**インストール済みの Chrome をクリックで操作**。PC とスマートフォンのエミュレーション。ログイン・店舗情報・機能の選択・擬似 Google の同意画面・接続後の表示・開始・Gmail の権限不足と権限の追加・切り替え待ち・通知先の招待・別のタブの2つの招待・テスト通知のシミュレーション)。
- `npx tsc --noEmit`・`npm run lint`・`npm run build`。
- 0021・0022・0023 はテスト用DBで適用・再適用(冪等)を確認。本番には未適用。

## 10. 外部の前提(手作業。2026-10-10 時点の実施状況は §1)

- **Google Cloud プロジェクトの整合**: 届いた口コミ(GBP API)の利用申請先(salonpack-gbp、no. 538962216680)と、共通 OAuth クライアントを作るプロジェクトを一致させる(GBP API は「承認されたプロジェクトの番号」で申請する)。口コミブランチの計画の「Gmail とは別プロジェクト・統合しない」は、今回の方針で置き換わる。
- **GBP API の利用承認と、Gmail の OAuth 審査は別**。`gmail.readonly` は Restricted scope で、"If you store restricted scope data on servers (or transmit), then you must go through a security assessment." → 必要に応じてセキュリティ評価を受ける。
- **公開ステータス**: 「テスト」のままだと "…publishing status of 'Testing' is issued a refresh token expiring in 7 days…" → 本番前に「本番」へ。
- **リダイレクトURI**: `https://<本番ドメイン>/api/google/oauth/callback`。
- **Vercel の環境変数(本番)**: `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`(新しいクライアント)、`GOOGLE_TOKEN_KEYS`・`GOOGLE_TOKEN_KEY_CURRENT`、`NEXT_PUBLIC_APP_URL`、`NOTIFICATIONS_CRON_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`。`GOOGLE_REVIEWS_OAUTH_ENABLED` は承認を確認するまで設定しない。
  - 本番には `SALONPACK_VERIFY_MODE`・`GOOGLE_OAUTH_SIMULATED`・`LINE_LOGIN_SIMULATED` を**設定しない**(どれかがあると、本番でも LINE へ送らない。定期処理の応答の `lineSendMode` が `simulated` になる)。
  - `LINE_REAL_SEND_VERIFY=1` は、実機確認のあいだだけ設定する。宛先が空なら1通も送らず、`lineSendMode` は `verify` になる。Lavi の開始(§5 の ④)の直前に削除する(手順書の段階4)。
  - Vercel のプレビューのデプロイからは LINE へ送らない(§8.3)。
- **LINE**: 長期のチャネルアクセストークンを**再発行しない**("Reissuing a long-lived channel access token will invalidate the currently active long-lived channel access token." → 旧サービスの通知が Lavi・ayana の両方で即座に止まる)。既存の値を使うか、v2.1 / ステートレスのトークンを別に発行する。
- **cron**: cron-job.org に SalonPack の `POST /api/cron/notifications/poll-mail` のジョブ(`Authorization: Bearer <NOTIFICATIONS_CRON_SECRET>`)。プロジェクトの関数の最大実行時間が60秒以上であること。
- **本番DB**: 0021 → 0022 → 0023 の順に適用してから、アプリをデプロイする。
  - 本番の現在のデプロイは 0020 の関数を使っていないので、アプリの切り戻しはスキーマのままでよい。
  - 0022・0023 の新しい列はすべて既定値つき。
  - 0023 は 0009 の `line_connections` に列を足すが、既存の制約は変えない。
- **事前確認**: 本番の `public.mail_connections` の件数(0件のはず。新しいコードは使わない)/ service_role が `hmail.mail_connections` を読めるか(定期処理・開始の監視。読めないと「確認できない」になり、開始できない)/ 運用 CLI の接続(`DATABASE_URL`)が `hmail.salons`・`mail_connections`・`line_connections`・`notification_settings`・`processed_emails`・`notification_history`・`cron_runs` を読めるか / hmail の関数の最大実行時間・cron の間隔 / ayana の旧側の行の受信用 Gmail(`<ayanaの予約受信用Gmail>`)が Lavi と別であること(`map` の確認だけの実行で見える)。
  - **2026-10-09 の結果**: service_role には hmail スキーマの USAGE も `hmail.mail_connections` の SELECT も無かった(ほかは期待どおり)。
    新側の監視(`reservation_ops_legacy_check`。service_role)に必要な最小限の権限 = スキーマの USAGE と、`salon_id`・`email_address`・`status` の
    3列だけの SELECT(`docs/plans/sql/hmail-legacy-watch-grant.sql`)。付与の前後の確認は `docs/plans/sql/hmail-legacy-watch-checks.sql`、
    手順は `docs/plans/lavi-release-runbook.md` の段階1の 2b。service_role は BYPASSRLS のため、RLS のポリシーは追加しない。
- **片付け**: hmail の bridge の Preview デプロイ(hmail-o2zzer8zu・-szxeypl7a・-7oistg4n0・-fs68j1vk4)と Preview の環境変数4つの削除、`chore/temp-migration-bridge` ブランチの削除(承認後)。
- **LINE ログインチャネル(通知先の追加を有効にするとき)**:
  - hmail の公式アカウントの Messaging API チャネルと**同じプロバイダー**に作る。
  - コールバック URL は `https://<本番ドメイン>/api/line/login/callback`。
  - 「Linked LINE Official Account」にその公式アカウントを設定する(友だち追加の案内のため)。チャネルを公開する。
  - 環境変数 `LINE_LOGIN_CHANNEL_ID`・`LINE_LOGIN_CHANNEL_SECRET`・`LINE_RECIPIENT_INVITES_ENABLED=1` を設定する。
  - **Messaging API チャネルの Webhook URL・トークンは変更しない**。
  - 設定するまでは、新規のお客様の通知先は運営が登録する(旧サービスのお客様は ⓪ で引き継ぐ)。
- **運営への問い合わせ先**: `NEXT_PUBLIC_SUPPORT_CONTACT_URL`(https: / mailto: / tel:)と表示名を設定する。未設定の間、画面には問い合わせのリンクが出ない。

## 10.1 既知事項(2026-10-09 時点。この段階では改修しない)

- **初回の cookie の競合**: 招待をまだ一度も開いていないブラウザで、2つの招待をほぼ同時に開くと、cookie の発行が競合し、片方の画面から連携を始められないことがある。安全側の失敗で(別の招待には切り替わらない)、届いたリンクを開き直せば続けられる。
- **ブラウザ確認の単発のタイムアウト**: `testdb:browser --reviews-enabled` の3回の実行のうち1回が、途中の待ち(60秒)で止まった。出力を絞っていたため、どの画面の待ちかは記録していない。続く2回は 58/58 件 OK で、再現していない。開発サーバーの初回コンパイルの遅れの可能性があるが、確認していない。
- **未確認(実機・本物のサービスが必要)**: LINE アプリ・LINE 内のブラウザでの招待と cookie の扱い、本物の LINE ログインの応答、Google の本物の接続とトークンの更新、Vercel 上の実行時間。→ `docs/plans/lavi-release-runbook.md` の実機確認・Google の段階で確かめる。

## 11. 口コミブランチ側の変更

`docs/plans/google-oauth-unification-reviews-branch.md` を参照(ブランチ自体は変更していない)。
