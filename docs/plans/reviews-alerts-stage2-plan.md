# 口コミ 第2段階「新着の自動取得とLINE通知」実装の記録と本番反映の手順

> ブランチ `claude/inspiring-keller-ffvsw5`(土台は master 1f3d4b7。master には入れていない)。
> 前提: 第1段階の引き継ぎ `docs/plans/reviews-inbox-stage1-handoff.md`、第1段階計画 `docs/plans/reviews-inbox-plan-v2.md`。
> このブランチでは、本番 DB・共有テスト用 DB・外部の設定・本物の Google/LINE/OpenAI には触れていない。検証は手元の PostgreSQL(localdb)・架空の Google・モックの LINE で行った。

## 1. 何ができるようになるか(要約)

- 画面を開いていなくても、Google の新しい口コミを定期的(15分ごと。Google の通知が使えるアカウントは即時+60分ごと)に確認して取り込む。取り込みは第1段階の同期(処理権・続きの位置・5分の間隔)をそのまま使う。
- 店舗が［LINE通知を開始する］を押すと、新しい口コミが届いたことだけを、口コミ通知を ON にした通知先の LINE に送る。文面はすべての口コミで同じ:

  ```
  【SalonPack】○○店
  新しい口コミが届きました。
  ［口コミを確認する］
  ```

  店舗名は SalonPack の登録店舗名。本文・抜粋・評価・投稿者名・写真・未返信件数は送らない(低評価・本文なしでも同じ)。第1段階の AI 入力の伏せ字は変えていない。
  **本文を送らないことだけで、Google の規定に関する未確認事項(§3 G1)が解決したとは扱わない。**
- ［口コミを確認する］は第1段階の口コミ詳細 `/dashboard/reviews/google/<SalonPack 内の UUID>`。未ログインならログインのあとにその口コミへ戻る。他店舗の口コミ・消えた口コミは第1段階の「表示できません」、Google 上で削除された口コミは説明と「一覧に戻る」。
- LINE の通知先(予約通知と共通)と SalonPack の閲覧者は別。リンクの先は、その店舗の SalonPack にログインできる人だけが開ける(新しいスタッフアカウント・ログイン不要のリンクは作っていない)。設定画面で案内する。

## 2. 実装したもの

| 区分 | 場所 | 内容 |
|---|---|---|
| DB | `supabase/migrations/0033_review_alerts.sql` | 自動取得の状態(`gbp_auto_sync`)・認証失敗の記録(`gbp_auto_auth_holds`)・実行記録(`gbp_auto_runs`)、LINE 通知の設定(`review_alert_settings`)・通知先ごとの口コミ通知(`review_alert_recipients`)・新着のイベント(`review_alert_events`)・配信(`review_alert_deliveries`)、`gbp_review_index` の挿入・選択の世代の終了・利用許可の変更のトリガー、各 RPC、招待ページの文言の出し分け(`line_flow_topics`) |
| DB | `supabase/migrations/0034_gbp_push.sql` | Google の通知(Pub/Sub)の受信の記録(`gbp_push_messages`)・通知設定の登録の状態(`gbp_notification_registrations`)と RPC |
| 自動取得 | `lib/gbp/autoSync.ts`、`lib/gbp/inbox.ts`(`syncForSchedule` を追加。既存の入口は変えていない)、`lib/gbp/store.ts`・`supabaseStore.ts`(`detected_via` を引数に) | 期限の来た世代ごとに、利用許可・同意・連携を確かめて第1段階の同期を呼ぶ |
| 通知 | `lib/reviews/alerts/*` | 評価・文面(Flex)・配信(claim・送信直前の確認・同じ retry key での再試行・23時間・月間通数の残し分)、定期処理、画面の表示 |
| LINE | `lib/notifications/line/LineClient.ts` | `pushMessages` を追加(`pushText` は同じ動きのまま `pushMessages` を使う)、月間通数の取得 |
| 入口 | `app/api/cron/reviews/tick/route.ts`、`app/api/google/reviews/push/route.ts` | 定期処理(Bearer `REVIEWS_CRON_SECRET`・`?dryRun=1`)、Pub/Sub の push(OIDC の検証 → 記録のコミット → 204) |
| 画面 | `app/dashboard/reviews/settings/*`、`components/reviews/settings/ReviewAlertsPanel.tsx` | 設定タブに「新しい口コミの自動確認」「LINE通知」(開始・停止・再開、通知先ごとの ON/OFF・招待・解除、テスト通知、最近の通知) |
| 画面 | `components/ops/ReviewAlertsOpsCard.tsx` | 運営画面 `/ops/salons/[id]` に状態を閲覧だけで表示 |
| 画面 | 招待ページ(`app/line/invite/*`・`components/line/*`)、予約通知の通知先の一覧、口コミ詳細 | 予約・口コミの文言の出し分け(予約通知だけの店舗は従来の文言)、解除が両方に効くことの案内、削除済みの口コミの「一覧に戻る」 |
| ログイン | `lib/auth/returnPath.ts`、`lib/supabase/proxy.ts`、ログイン画面・`LoginForm`・`app/auth/actions.ts`・`/auth/verify` | 戻り先は口コミ詳細の形だけ。本人確認・店舗の登録などの手順は先に通す |
| 同意 | `components/reviews/inbox/connectCopy.ts`、`GBP_CONSENT_VERSION` = `gbp-connect-2026-10-16-v3` | 画面を開いていないときの確認・Google の通知の設定への登録・通知の記録(30日)を追加。同意済みの店舗は同意し直し(本番で同意した店舗はまだ無い) |
| 設定例 | `.env.example` | 第2段階の環境変数 |
| 手順の SQL | `docs/plans/sql/0033-0034-{precheck,verify,rollback}.sql` | 適用の前後の確認と切り戻し(localdb で、確認 → 適用 → 確認 → 切り戻し → 再適用を通した) |

### 変えていないもの

予約通知の表・関数・定期処理(`notifications_*`・`reservation_*`・`lib/notifications/jobs/**`)、Gmail 連携、適用済みの migration(0001〜0032)、0023 の `line_recipient_stop_review_notifications` と旧口コミ通知の表、第1段階の同期・取り込み・返信の DB 関数、AI 入力用の伏せ字。

### 主な決まり(実装どおり)

- **新着**: `gbp_review_index` に行が初めて入ったとき、その世代の初回の取り込みが済んでいればイベント(第1段階の「新着」と同じ起点)。初回の取り込み・編集・25日後の取り直し・手動と自動の重なり・Pub/Sub の重複は、イベントにならないか1件になる。
- **送る相手**: 投稿日時が、開始・再開の時刻・選択の時刻・通知先の登録時刻・その通知先の口コミ通知を ON にした時刻のすべてより後のときだけ。処理の時点で ON かどうかではなく投稿日時で決めるので、検知・評価が遅れても ON にする前の口コミは届かない。OFF→ON で再試行中の配信は復活しない。
- **遅れ**: 投稿から72時間を過ぎて検知した口コミ・検知から24時間評価できなかった口コミは送らない。
- **停止**: お客様の停止・利用許可の変更・連携先の変更・同意の更新で止まり、再許可だけでは再開しない(［再開する］)。停止中に投稿された口コミは再開しても送らない。送信を始めたものは取り消せないため、件数を表示する。
- **再試行**: 同じ retry key・同じ内容・同じ宛先で、最初の試行から23時間・最大20回。409(受付済み)は送信済み。月間通数の残りが `REVIEW_ALERT_LINE_QUOTA_RESERVE`(既定10%)未満なら口コミ通知だけ止める。
- **Google の認証失敗**: 口コミの処理からは `google_record_auth_result` を呼ばない(第1段階と同じ。予約通知の Gmail の停止記録・連絡に影響させない)。自動取得の `invalid_grant` は `gbp_auto_auth_holds`(アカウント×トークンの世代)にだけ記録し、同じ世代で2回続いたら、そのアカウントの自動取得を止めて「Googleとの連携の確認が必要です」と表示する。再連携でトークンの世代が変われば戻る。
- **Pub/Sub**: 受信の記録と前倒しの依頼を1トランザクションでコミットしてから 204。`after()` が途中で止まっても、次の cron が同期する(`after()` の完了に頼らない)。通知設定は、そのアカウントの店舗が LINE 通知を開始したときに登録し、ほかのツールのトピックなら変更しない。
- **記録の削除**: 第2段階の記録は30日(Pub/Sub の受信は7日)で削除。通知の停止・利用許可・フラグに関係なく、定期処理で毎回行う。
- **利用許可**: 新しい機能カタログの行は作っていない。口コミの LINE 通知は `google_reviews` の判定(0032 により口コミ(reviews)の許可に連動)に従う。全体の停止は環境変数。

## 3. 先に確認が必要な依存事項(ゲート)

| # | 依存事項 | 止めるもの | 担当 |
|---|---|---|---|
| G1 | Google の規定との関係(第1段階の (a)〜(d) に加えて、(e) 画面を開いていないときの定期取得と一時保存(25日)の取り直し、(f) Google の通知(Pub/Sub)の利用、(g) 口コミに結び付く SalonPack 内の ID と日時の30日の記録) | 本番での自動取得・LINE 通知の開始 | 利用者(Business Profile API のサポートへの書面の質問など) |
| G2 | 実店舗での読み取りだけの確認(口コミの一覧の本物の応答、通知設定の `GET accounts/{a}/notificationSetting`。書き込みはしない) | 本番での自動取得・Pub/Sub の登録 | 利用者 |
| G3 | 本番 DB に 0027〜0032 が適用済み(`0033-0034-precheck.sql` §1)と、第1段階の期限切れの削除のジョブの定期実行 | 0033・0034 の本番適用とマージ | 利用者(読み取りのみで確認) |
| G4 | LINE 公式アカウントのプランと月間通数(予約通知と共有)。残し分の割合(推奨10%) | 本番での口コミの LINE 送信 | 運営 |
| G5 | 同意文(v3)とプライバシーポリシーの追記(§6 の案。法務の確認を含む) | 本番での自動取得・LINE 通知の開始 | 利用者 |
| G6 | Google Cloud の Pub/Sub(トピック・`mybusiness-api-pubsub@system.gserviceaccount.com` の Publish 権限・push サブスクリプション)と、本物の通知の項目名の確認 | Pub/Sub による即時の検知(定期の確認だけなら不要) | 利用者。G1・G2 のあと |
| G7 | Vercel のプラン、cron-job.org のジョブ(口コミの定期処理 5分ごと・第1段階の削除のジョブ 毎日) | 本番の定期処理 | 運営 |

## 4. 本番反映の手順(DB を先に。旧アプリと互換)

0033・0034 は追加だけ(既存の表の列・既存の関数を変えない。トリガーは単純な挿入・更新だけ)。今の master のアプリは、適用後の DB でもそのまま動く(localdb で、第1段階・予約通知のテストを 0034 まで適用した DB で通している)。**新しいアプリは、DB の新しい表・関数がそろっている前提で動く(フラグを空にしても DB の未適用は補えない)**ため、順序は必ず DB → アプリ。

1. **事前の確認(読み取りのみ)**: SQL Editor で `docs/plans/sql/0033-0034-precheck.sql`。§1 がすべて true、§2 がすべて null。§3 の結果を控える。
2. **DB**: `0033_review_alerts.sql` → `0034_gbp_push.sql` を、ファイル全体で1回ずつ適用。
3. **適用後の確認**: `docs/plans/sql/0033-0034-verify.sql`。表が空・RLS・権限・トリガー、§5 が手順1の §3 と同じ。この時点のアプリは master のまま動く。
4. **アプリ**: master にマージして本番デプロイ。`GBP_AUTO_SYNC_ENABLED`・`REVIEW_ALERTS_ENABLED`・`GBP_PUBSUB_ENABLED` は空のまま。cron のジョブはまだ作らない。
   - 同意の版が v3 になるため、第1段階で同意した店舗(本番ではまだ無い)は同意し直しになる。
5. **自動取得だけ(G1・G2・G5 のあと)**: `REVIEWS_CRON_SECRET`(32文字以上)を入れ、cron-job.org のジョブ(`POST /api/cron/reviews/tick`、`Authorization: Bearer …`、5分ごと)を `?dryRun=1` で確認 → 自分たちの店舗で `GBP_AUTO_SYNC_ENABLED=1`。数日、取得・削除・失敗の表示と、認証失敗が予約通知に影響しないことを見る。
6. **LINE(G4 のあと)**: `LINE_REAL_SEND_VERIFY=1` と自分の LINE だけを `LINE_REAL_SEND_VERIFY_DESTINATIONS` にして `REVIEW_ALERTS_ENABLED=1`。自分たちの店舗で［LINE通知を開始する］→ テスト通知 → 実際の新着(**確認のために口コミを投稿させない。Google の規約違反になる。自然に届くのを待つ**)。リンクの未ログイン→ログイン→元の口コミ、LINE の中のブラウザも実機で確かめる。
7. **Pub/Sub(G6)**: Google Cloud を設定し、`GBP_PUBSUB_AUDIENCE`・`GBP_PUBSUB_PUSH_SA_EMAIL`・`GBP_PUBSUB_SUBSCRIPTION`・`GBP_PUBSUB_TOPIC` を入れてから `GBP_PUBSUB_ENABLED=1`。事前に自分たちのアカウントの通知設定に他のトピックが無いことを確かめる。本物の通知で項目名を確認する。
8. **公開**: `LINE_REAL_SEND_VERIFY` を外す。Google口コミを使える店舗が、それぞれ［LINE通知を開始する］で使い始める。

第1段階と第2段階をまとめて公開する場合も、DB(0027〜0034)を先に適用してからマージする順序は同じ。

### このブランチの Preview

`vercel.json` の `git.deploymentEnabled` で `claude/inspiring-keller-ffvsw5` の Preview のデプロイを止めている(Preview は本番 Supabase に接続するため)。このブランチを最初に push したとき(2026-10-16)には、この設定のコミットがすでに含まれていた。念のため、Vercel にこのブランチの Preview が作られていないことを確認すること。本番 DB につながる Preview は検証に使わない。master にマージするときは、この行を残しても害はない(このブランチ名だけに効く)。

## 5. 切り戻し

- **アプリ**: master の前のデプロイに戻す(DB は追加だけなので、旧アプリはそのまま動く)。cron-job.org の口コミの定期処理を止め、`GBP_PUBSUB_ENABLED` を空にする。
- **DB(必要なときだけ)**: `docs/plans/sql/0033-0034-rollback.sql`(トリガー → 関数 → 表の順。第2段階の記録だけが消え、第1段階・予約通知の行は消えない)。SalonPack のトピックを Google の通知設定に登録済みなら、先にアプリから解除するか Google 側で解除する。

## 6. プライバシーポリシーの追記の案(画面にはまだ出していない。G5 で法務の確認のうえ確定)

**2-6. Google の口コミの確認と返信** に追加:

- 画面を開いていないときも、店舗が連携した Google ビジネスプロフィールの新しい口コミを定期的に確認して取り込みます(取り込んだ内容の扱い・保存期間はこれまでと同じです)。
- 店舗が口コミの LINE 通知を開始すると、Google の通知の仕組み(Google Cloud Pub/Sub)を使って新しい口コミをすぐに確認するため、店舗の Google ビジネスプロフィールの通知の設定に本サービスを登録します。ほかのサービスがすでに通知の設定を使っている場合は変更しません。Google から受け取る通知のうち、本サービスが保存するのは通知の識別子・種類・店舗(ロケーション)の名前・日時だけです(7日で削除)。
- LINE 通知: 新しい口コミが届いたとき、店舗が口コミ通知を ON にした通知先の LINE に、登録された店舗名と、本サービスで口コミを確認するためのリンクだけを送ります。口コミの本文・評価・投稿者の名前や写真は送りません。リンクの先は、その店舗の本サービスにログインできる方だけが開けます。
- 通知の記録: 新しい口コミを見つけた日時、通知の対象かどうかの判定、送信の日時と結果(本サービスの中の識別子を含み、口コミの内容は含みません)を30日間保存し、その後削除します。

**外部送信(LINEヤフー)** の項: 「Messaging API による予約通知・テスト通知の送信」に「口コミの通知(登録店舗名と確認のリンク)」を加える。

**保存期間** の項: 「口コミの通知の記録(2-6): 30日。Google からの通知の受信の記録: 7日」を加える。

## 7. 検証の結果(このブランチ)

- `npx tsc --noEmit`・`npx eslint .`(既存の `lib/access/userPermission.ts` の警告3件のみ)
- `npx vitest run`: 1件を除いて通過。失敗の1件 `__tests__/lib/replyGeneration/engine.test.ts`「★の数そのものは口コミに無い数字として扱わない」は **master(1f3d4b7)でも同じく失敗する既存の不具合**(このブランチの変更とは無関係。直していない)
- `npm run test:localdb`: 全件通過(0033・0034 の適用・再適用、新着のイベント、評価・送信直前の確認と競合、停止と取り消せない件数、自動取得と認証失敗の記録、Pub/Sub の受信直後に止まった場合の cron による続き、記録の削除、権限、招待ページの文言の出し分け、第1段階・予約通知の既存のテスト)
- `npm run build`
- 手順の SQL(確認 → 適用 → 確認 → 切り戻し → 再適用)を localdb で通した
- 共有テスト用 DB への適用(`test:testdb`)とブラウザでの通しの確認(設定タブ・開始/停止・通知先の ON/OFF・テスト通知のシミュレーション・LINE のリンクから未ログイン→ログイン→元の口コミ)は、**許可を得てから行う**(未実施)

## 8. 残っていること・判断が必要なこと

1. 同意文 v3 とプライバシーポリシーの追記(§6)の確定(G5)。
2. LINE の月間通数の残し分の割合(推奨: 月の上限の10%。`REVIEW_ALERT_LINE_QUOTA_RESERVE`)(G4)。
3. 自動取得で一時保存を取り直し続けてよいか(G1-(e))。否定的なら、自動取得は差分だけにし、全件の取り直しは手動の［更新］だけにする変更を足す。
4. 共有テスト用 DB への 0033・0034 の適用と、ブラウザでの通しの確認(許可を得てから)。
