# 口コミ（届いた口コミ・AI返信）実装計画 — Google API 承認後（調査と計画のみ・第2版）

> この文書は 2026-10-15 の計画の写し(元はリポジトリの外)。その後の実装で決まったこと・第2段階の方針の変更(LINE に本文・評価を載せない)・マージと本番反映の順序は `docs/plans/reviews-inbox-stage1-handoff.md` を優先する。

作成 2026-10-15。コード・マージ・デプロイ・DB・外部の設定は変更していない（読み取りだけ）。
調べた対象：origin/master（78df7e5）、PR #9（origin/feature/salon-onboarding b7e5681 ＋ worktree `review-app-onboarding` の未コミット約55件。触っていない）、口コミのブランチ（`review-app-reply` 07d8fa6）、master の `docs/plans/google-oauth-unification-reviews-branch.md`（10/08）、Google の公式資料（Policies 2026-08-28、reviews.list 2026-04-07、FAQ・Prerequisites 2026-08-28）。
第2版の変更：期限切れの削除を利用許可から切り離す（§3-9）／連携の変更と処理の重なり（§3-A）／未返信と結果不明の区別（§2）／新着の定義（§2）／登録側のコードと本番デプロイへの依存を分ける（§4）／403 の分類（§3-B）。

## Context
- `salonpack-gbp`（538962216680）の Business Profile API の利用が承認された（300 QPM）。本番の Google 連携のクライアントもこのプロジェクトのもの（確認済み）。OAuth の設定（`business.manage` は「非機密」に追加済み・公開ステータス本番）も済んだ。
- **API の利用承認と OAuth の設定は、準備の一部にすぎない**。規定との関係の確認（§7-1）、プライバシーポリシー・同意文、期限切れの削除の定期実行、実店舗での確認は済んでいない。
- 口コミの機能は古い口コミのブランチにあるが、master にはその後、共通の Google 連携（0021）・運営管理と利用可否（0024）が入り、PR #9 が登録と利用区分（0025・0026）を変更中。
- 目的：貼り付け型をやめ、「Google連携 → 店舗の選択 → 口コミの取得 → 選択 → AI返信案 → 確認・編集 → 明示的な投稿」に統一し、最新の仕組みの上で作り直す。

---

## 1. 現在できていること／デモだけのこと／未実装

| 機能 | 状態 | 根拠 |
|---|---|---|
| 返信文の作成エンジン（分類・指示文・文章チェック・1回の修正・署名） | **実装済み**。本物の OpenAI で動くのは貼り付け型の経路（`generateReplyFromPasteAction`）だけ。架空34件の評価済み | `lib/replyGeneration/{classify,prompts,lint,pipeline,text}.ts` |
| 返信の設定（トーン・長さ・店舗名・再来店・署名・連絡先・追加の指示） | 実装済み・テストDBで確認。本番DB未適用 | 旧0013、`ReplySettingsForm` |
| 回数の上限・使用量の記録（本文なし） | 貼り付け型の経路だけ | `rateLimit.ts`、`recordGenerationEvent` |
| 共通の Google 連携（Gmail と口コミの権限をまとめて要求） | **本番で稼働**（Gmail）。口コミの権限は `GOOGLE_REVIEWS_OAUTH_ENABLED` で停止中 | master `lib/google/*`、0021 |
| 口コミ用の独自の連携（`gbp_connections`・独自の callback・独自の暗号化） | ブランチにあるが **master と重複 → 廃止** | 旧0015、`lib/gbp/oauth.ts`、`secretBox.ts` |
| 店舗（ロケーション）の選択 | **デモだけ**（ブランチ・架空Google）。master は `gbp_selection_state` の列だけ | `loadBusinesses`/`selectLocation` |
| 口コミの取得（再開できる同期・25日の一時保存・HMAC の識別子） | **デモ＋テストDB**。本物の HTTP の部品はあるが**未接続**（本番は常に「準備中」） | `lib/gbp/apiClient.ts`、`backend.ts`、旧0016 |
| 一覧・詳細・下書き・既読・削除済み/期限切れの表示 | デモ＋テストDB | `ReviewsInbox`、`ReviewDetailView` |
| 口コミ数・平均評価（Google の値） | 表示の実装あり（架空Google） | `gbp_locations.average_rating/total_review_count` |
| 新着件数・未返信件数 | **未実装**（`first_seen_at` は保存しているが未使用） | — |
| この口コミから返信案（D2） | **常に架空の文章（モック）**。本番では明示的に拒否 | `generateReplyForReviewAction` |
| Google への返信・置き換え・削除（確認・二重防止・結果不明は自動で送り直さない・競合） | **架空Google＋テストDB**（同時実行も実DB）。本物未接続 | 旧0017、`submitReply`、`ReviewComposer` |
| 状態（審査中・公開済み・公開できませんでした）の表示 | 取り直した Google のデータだけで表示する作り。**本物の応答の形は未確認** | `replyState.ts` |
| 期限切れの内容の削除 | 関数はある。呼び出し口は**架空の Google のときしか動かない**・定期実行なし | `gbp_purge_expired_content`、`/api/jobs/gbp-maintenance` |
| 新着の自動検知・定期同期・状態の定期確認・口コミの LINE 通知 | **未実装**（LINE は送信部品だけデモ） | 旧0014、`lib/reviewNotifications/*` |

**個人情報の扱い（今の実装）**：投稿者名は AI に送らない（`getReplyInput` は本文と★だけ）。本文は**そのまま送る**（伏せ字なし、最大4000字）。出力側で「名前・URL・電話・メールを書かない」（指示文）と URL・メール・電話・LINE ID のチェック。人名・スタッフ名のチェックは未実装。

**連携の変更と処理の重なりへの今の備え**：同期・口コミの書き込み・返信の操作の DB 関数は「その店舗のロケーションが有効か」を確かめる。ただし `gbp_upsert_reviews` は同期の処理権（lease）を確かめず、同じロケーションを選び直すと古い処理が書き戻せる。投稿の直前に利用可否は確かめていない。

---

## 2. 利用者の画面構成と操作の流れ

**入口は増やさない。「口コミ」の中を3つのタブにする**（`components/blog/BlogSubNav.tsx` の形）。
- 2026-10-15 にタブの名前と並びを変更した(URL・機能の ID・DB は変えていない):
  **口コミ** `/dashboard/reviews/google`・`/[id]`(旧「届いた口コミ」)｜**アンケート** `/dashboard/reviews`(旧「口コミを集める」。今の画面のまま)｜**設定** `/dashboard/reviews/settings`（Google 連携の状態と店舗の変更・AI返信の設定。第2段階で LINE 通知）
- タブは `google_reviews` を使える店舗にだけ出す。使えない店舗の画面は今と同じ。
- Google連携・運営の画面では、`google_reviews` を「Google口コミ」と呼ぶ(アンケートの「口コミ」と区別するため)。

**入口**(`google_reviews` を使える店舗は、どの入口からも「口コミ」タブを開く。`lib/features/reviewsEntry.ts`)
- 口コミプラン（`reviews_direct`）のログイン後：「口コミ」タブ。**アンケート未作成でも初期設定へ飛ばさない**（`reviewsDirectDestination`）。アンケートの初期設定を終えた直後だけは、お客様用URLを案内するため「アンケート」タブ。
- 左のメニュー・下のメニューの「口コミ」：「口コミ」タブ。どのタブでも「口コミ」を選択中にする。
- SalonPack のホームの「口コミ」のカード：「口コミを使う」で「口コミ」タブ(アンケート未作成でも「設定が必要」にしない)。
- 「アンケート」タブは、アンケート未作成ならタブの中で作成への案内を出す。「アンケート」「設定」を選んだとき・URL を直接開いたときは、その画面を出す。
- Google と未連携なら、「口コミ」タブの中で連携を案内する。
- 使えない店舗は今の動き(メニューの「口コミ」はアンケート、未作成なら初期設定)。
- 登録・本人確認・利用区分（PR #9 の `resolveNextStep`）を先に通す。通らない店舗はこの画面に来ない。

**操作の流れ**
1. 未連携：「口コミ」タブに説明と、連携の前の同意（30日以内の一時保存・返信はボタンを押したときだけ）と「Google と連携する」。
2. 連携は共通の Google 連携。Gmail をすでに連携しているアカウントなら**権限の追加**（`add_scope`）。
3. 戻ってきたら**店舗（ロケーション）の選択**を必ず通す（1件でも確認する）。
4. 最初の取り込み。件数が多ければ「続きを取得する」で進める（自動では進まない）。
5. 一覧で口コミを選ぶ → 詳細で「AIで返信案を作る」→ 編集 →「Googleに返信する」→ 確認ダイアログ → 結果。

**届いた口コミの画面（上から）**
1. 新着のお知らせ（1件以上のときだけ）：「新しい口コミが○件あります（{最終更新}の更新で見つかったもの）」→ 押すと新着だけの一覧。
2. 数字（Google の値）：口コミ数・平均評価。注記「Google上の値・{時刻}時点」。
3. 最終更新と［更新］。注記「新しい口コミは［更新］を押すと取り込みます」（リアルタイムに見える言い方をしない）。
4. 絞り込み：未返信（既定）／確認が必要／返信済み／すべて、★、並び順。
5. 一覧（PCでは右に詳細）。

### 返信の状態（「未返信」と「結果不明」を分ける）
上から順に判定し、当てはまった1つを表示する。Google の状態は**取り直した Google のデータ**だけで決め、推測しない。

| 表示 | 条件 | 絞り込み | 主な操作 |
|---|---|---|---|
| 送信中… | SalonPack の操作が送信中 | 確認が必要 | （待つ） |
| **送信結果を確認中** | 時間切れ・通信の失敗などで結果が分からない（`unknown`）、または Google が受け付けたが反映をまだ確かめていない（`sent_checking`） | 確認が必要 | ［Googleで確認する］（取り直す）だけ。**再投稿のボタンは出さない** |
| 送信できませんでした | 送る前に止まった・Google が拒否した（送っていないと分かる `failed`）で、Google 上に返信が無い | **未返信** | 文章はそのまま。［もう一度送る］ |
| **置き換えできませんでした（以前の返信が残っています）** | 置き換えの操作が失敗・拒否され、取り直した Google には以前の返信がある | 確認が必要 | 以前の返信と編集中の文章を並べる。［もう一度置き換える］ |
| 削除できませんでした（返信が残っています） | 削除の操作が失敗し、Google に返信がある | 確認が必要 | ［もう一度削除する］ |
| 公開できませんでした | Google の返信が `REJECTED` | 確認が必要 | 理由（`policyViolation`）と［内容を直して置き換える］ |
| 審査中／公開済み／返信済み | Google の返信が `PENDING`／`APPROVED`／状態なし | 返信済み | ［置き換える］［削除］ |
| **未返信** | 取り直した Google のデータで**返信が無いと確認でき**、送信中・結果不明の操作が無い | 未返信 | ［AIで返信案を作る］ |

- 「送信結果を確認中」は、［Googleで確認する］で取り直した結果で次の状態に移る：反映されていた → 審査中など／返信が無い（送られていなかった）→ 未返信（「前回の送信は反映されていませんでした」と添える）→ ここで初めて［もう一度送る］を出す／別の返信が付いていた → 競合の画面。
- 取り直しの前に、同じ文章をもう一度送れる経路は作らない（今の「確認してからもう一度送る」は、取り直しと確認を必ず先に行うので維持する。表示は確認だけにする）。

### 新着の定義（第1段階は［更新］で取り込んだときに見つかったもの）
- **対象**：連携してその店舗を選び、**最初の取り込み（初回の全件の取得）が最後まで終わったあと**に、SalonPack が**初めて見つけた**口コミのうち、まだ詳細を開いていないもの（店舗単位。誰かが開けば新着から外れる）。
- 場合ごとの扱い
  - 初回の取り込みで見つかった過去の口コミ：新着に含めない。初回が複数回の［続きを取得する］に分かれても、初回が終わるまでに見つかったものは全部「初回の分」。
  - 初回の途中：新着の数字は出さない（「口コミを取得しています」を表示）。
  - 既存の口コミを投稿者が編集した：新着にしない（「投稿者が編集」の印だけ）。
  - 25日を過ぎて内容を消したあとの取り直し：新着にしない（その口コミをすでに見つけたという記録で判定）。
  - 2回目以降の取り込みが複数回に分かれて途中：それまでに見つかった新着は数える。「続きがあります」も表示する。
  - 店舗を変えた・連携し直した：新しい店舗の初回として扱う（前の店舗の記録は消す）。
- **実現方法**：`gbp_review_index` に「初めて見つけた日時」（`first_seen_at`、既存）と「既読」（`seen_at`、既存）、`gbp_locations` に「初回の取り込みが終わった日時」（既存の `initial_sync_done_at`）。新着＝`first_seen_at > initial_sync_done_at` かつ `seen_at` が空、かつ内容の一時保存が期限内（開いて見られるもの）。新しい RPC で、ページ分割に関係なく店舗全体の件数を返す。
- **保持できるデータの範囲（要確認）**：この判定は、口コミの識別子の HMAC（元に戻せない値）と日時を、内容の一時保存（25日）より長く持つことが前提。これが規定の「Content」の保存に当たらないかは未確認（§7-1）。認められない場合は、新着の数字を出さない（または一時保存の期間内だけの判定にする）。

**数字の定義**
| 表示 | 定義 | 範囲 | 出さないとき |
|---|---|---|---|
| 新着 ○件 | 上の定義 | SalonPack の検知の記録 | 初回の途中・初回が終わっていない |
| 口コミ数・平均評価 | `reviews.list` の `totalReviewCount`・`averageRating`（公式：「all reviews for this location」） | Google の店舗全体の値（最後に取得した時点） | 一度も取得していない・25日を過ぎて消した →「—」と「更新すると表示されます」。**0とは表示しない**（Google が0件と返したときだけ0件） |
| 未返信 ○件 | **保留**（§7-1）。数字は出さない | — | — |

**状態の表示**：読み込み中（最初だけ Skeleton、更新中は一覧を残す）、失敗（原因ごとに説明と［もう一度試す］か［再連携する］。§3-B）、未連携（連携の案内）、口コミ0件（「まだGoogle口コミはありません」＋［口コミを集める］）、未返信0件（「未返信の口コミはありません」＋［すべて表示］）、取り込み途中（［続きを取得する］）、期限切れの口コミがある（［更新］で取り直す）。

**デザイン（既存の色・余白・影なしの枠線カード。主な操作だけ sage）**
- 優先順位：①新着の帯（sage-soft）②口コミ本文（一覧・詳細の主役）③返信ボタン（詳細の primary）④数字（控えめなカード）。
- PC（領域 848px 以上）：新着の帯 → 数字のカード2枚と右端に最終更新・［更新］→ 一覧 340px と詳細の2列。
- スマホ：新着の帯 → 数字のカード2枚を横並びで小さく → 横スクロールの絞り込み → 一覧。詳細は全画面で「‹ 一覧へ」。返信の操作は返信欄のすぐ下（画面下に固定しない）。

---

## 3. 第1段階・第2段階の実装範囲

### 第1段階（画面を更新して確認・返信できる状態）
1. **統合画面**：`ReviewsSubNav`（3タブ）、入口の分岐、アンケート未作成の扱い。
2. **貼り付け型の削除（UI・入口だけ）**：`PasteReplyTool`・`PasteBackLink`・`/dashboard/reviews/google/paste`・ヘッダーのリンク・`ReviewComposer` の `showPaste`・`draftMemory.ts` とログイン/メニューの呼び出し。
   - **先に共通処理を抜き出す**：`generateReplyFromPasteAction` の「本物の OpenAI＋回数の上限＋使用量の記録」を `lib/replyGeneration/service.ts`（新規）へ。型も actions から外す。
   - 残す：分類・指示文・文章チェック・修正・設定・回数の上限・`suggestionPlacement`・`isReplyEdited`/`placeNewDraft`。
3. **共通の Google 連携に合わせる**（`docs/plans/google-oauth-unification-reviews-branch.md` に沿う）
   - 削除：`lib/gbp/oauth.ts`・`secretBox.ts`・`/api/google-business/oauth/callback`・旧の連携部分・`gbp_connections`/`gbp_oauth_states` とその関数・`GBP_OAUTH_*`/`GBP_TOKEN_*`。
   - アクセストークン：`salon_google_bindings(feature='gbp')` → `google_accounts` → `obtainGoogleAccessToken` を `lib/gbp/source.ts` に注入。
   - 店舗の選択：Google の一覧の取得は既存の `loadBusinesses` を使い、選択は1つの RPC で「新しい選択の世代を作る（§3-A）・`gbp_selection_state='selected'`」。
   - 口コミの利用停止（`stopFeatureAction('gbp')`）・アカウントの切り替え：口コミの結び付けだけを変え、その店舗の一時保存・下書き・索引を消す。Gmail と取り消しには触れない。
   - 連携の同意の記録：`gbp_consents` を残し、連携の開始の前に記録する。
4. **本物の API への接続**：`lib/gbp/runtime.ts` で `createGbpHttpApiClient()` を組み立て、`backend.ts` に本番の種類を足す。架空の Google（`lib/gbp/simulated.ts`）は master の架空モード（`GOOGLE_OAUTH_SIMULATED`＋testdb）だけ。
5. **取得・一覧・集計**：既存の同期（5分に1回まで・続きはすぐ）、新着件数の RPC、数字の表示、途中・期限切れの表示。
6. **AI返信案（D2）**：`service.ts` 経由で本物の OpenAI。送るのは本文・★・設定だけ（投稿者名なし）。**送る前に本文中の電話番号・メールアドレス・URL を伏せ字にする**（人名は対象外）。上書きしない・失敗しても文章を残す（既存）。
7. **Google への返信・置き換え・削除**：既存の流れ（確認ダイアログ・op_id・処理権・送る直前の取り直し・結果不明は自動で送り直さない・競合）を本物の API とトークンにつなぐ。状態の表示は §2 の表に直す（未返信と確認が必要を分ける）。
8. **利用可否の統合**：`google_reviews` を DB の機能一覧（0024 の `feature_catalog`）に移す（`entitlement: "catalog"`、提供状態 `coming_soon`、口コミプラン・SalonPack プランの対象、**標準は使えない**）。0025 の `salon_feature_access` で利用区分も反映される。AI返信・返信の設定も `google_reviews` で判定（今の `review_replies` は登録が無く全店舗で「使える」扱いのため使わない）。**画面・サーバーの操作・API・生成・投稿・同期**のすべてで同じ判定（`resolveFeatureSalon`/`canAccessFeature`）。
9. **期限切れの内容の削除（利用許可から切り離す）**
   - 削除のジョブ（`/api/jobs/gbp-maintenance` → `gbp_purge_expired_content`）は、**利用停止・契約対象外・`coming_soon`・`GOOGLE_REVIEWS_OAUTH_ENABLED` が空・店舗の利用開始待ちでも実行する**。利用可否・フラグ・Google の接続を見ない（Google を呼ばない、DB の中の削除だけ）。
   - 認証は維持：専用の秘密の値（Bearer、`timingSafeEqual`。poll-mail と同じ形）。値が未設定なら動かさずにエラー。
   - 今の「架空の Google のときしか動かない」制限を外す。
   - 毎日実行（外部のスケジューラー）。読み出しも期限で絞る（既存）。連携の解除・店舗の変更・アカウントの切り替えでは、その場で消す（既存の `gbp_purge_salon_content` を使う）。
   - 対象：口コミの一時保存・下書き・店舗名と★の平均・件数の一時保存（25日）。テストで「`coming_soon`・利用不可の店舗でも消える」「秘密の値が無いと拒否」を確かめる。

### 3-A. 連携の変更と、実行中の処理が重なったとき
**考え方**：店舗の選択ごとに「選択の世代」を持つ（選び直しのたびに `gbp_locations` を新しい行にする。同じロケーションを選び直しても、前の行は使わない）。すべての書き込みは「その世代の行が有効で、店舗の結び付けが同じアカウントを指している」ときだけ通る。

| 変更 | 実行中の処理 | 扱い |
|---|---|---|
| 解除・アカウントの切り替え・店舗の変更 | 同期（取得中） | 書き込み（口コミ・続きの位置・終わりの記録）の DB 関数が、世代の行が有効か・同期の処理権が一致するかを確かめて拒否する。**`gbp_upsert_reviews` にも処理権の確認を足す**。取得済みの内容は捨てる |
| 同上 | AI 生成 | 生成の結果は、返すときに対象の口コミがまだ有効な世代にあるかを確かめ、違えば捨てる（「連携が変わったため、返信案を表示しませんでした」）。下書きの保存（`gbp_save_draft`）も世代で拒否する。画面は、受け取った結果の口コミ・世代が今の表示と違えば表示しない |
| 同上 | 下書きの自動保存 | 世代の違う口コミへの保存は拒否。画面の入力は残す（コピーできる） |
| 同上 | 投稿（送る前） | 操作の開始（`gbp_begin_reply_operation`）と**送る直前**（`gbp_reply_start_send`）の両方で、世代の行が有効・結び付けが同じアカウント・**`salon_feature_access(店舗, 'google_reviews')` が使える**（0024 の送信の直前の確認と同じく、利用可否の基準行を FOR SHARE してから読む）を確かめる。アプリ側でも `GOOGLE_REVIEWS_OAUTH_ENABLED` と利用可否を送る直前に確かめる。どれかが違えば送らない（送っていないので「送信できませんでした」） |
| 同上 | 投稿（送信を開始したあと） | Google への送信は取り消せない（Google 側で反映されうる）。結果が返ってきても、**一時保存・下書きには書き戻さない**（終わりの記録の関数が世代で拒否）。操作の記録（本文なし）は「結果不明」で残す。再連携して同じロケーションを選んだら、取り直して確かめるまで「送信結果を確認中」にする |
| 利用可否が「使えない」に変わった | 同期・生成・投稿 | 次の書き込み・送る直前の確認で止める。一時保存は期限の削除（§3-9）で消える |

- 店舗が違う画面への表示：どの RPC も `salon_id` で絞る（既存）。サーバーの操作は、受け取った口コミの ID が今の店舗・今の世代のものか確かめる。
- **検証**：Google の応答を遅らせる架空の API と遅らせた生成で、次を確かめる。
  - 解除・切り替え・店舗の変更が、同期の途中・生成の途中・送る直前・送信の開始後に起きたとき、古い処理が一時保存・下書きを書き戻さない。別の店舗・別の世代の画面に表示しない。
  - 送る直前に利用不可になったら送らない。
  - 送信の開始後の結果は「結果不明」の記録だけになる。
  - 実 DB（localdb とテスト用DB）で同時実行も確かめる。

### 3-B. Google API の失敗の分類（403 を一律に権限不足にしない）
- master の `classifyGoogleError`（`lib/google/errors.ts`）の考え方を使う：403 で、エラーの詳細の理由が `ACCESS_TOKEN_SCOPE_INSUFFICIENT`・`insufficientPermissions`・`insufficient_scope` のどれか（または `WWW-Authenticate` の `insufficient_scope`）のときだけ「権限不足」。
- 口コミの API の分類（`lib/gbp/apiClient.ts` の `forbidden` を分ける）

| 分類 | 判定 | 連携の状態の変更 | 表示 |
|---|---|---|---|
| 権限不足 | 上の理由がある403 | **口コミの結び付けにだけ** `markBindingScope(salon,'gbp',…)`（`google_mark_binding_scope`） | 「口コミの権限が足りません。［権限を追加する］」 |
| 店舗の権限が無い | 403 `PERMISSION_DENIED` で権限不足の理由が無い（その店舗の管理者でないなど） | 変えない | 「この店舗を管理する権限を確認できません」 |
| API の設定の問題 | `SERVICE_DISABLED`・`accessNotConfigured` など | 変えない（運営への警告のログ） | 「現在ご利用いただけません」 |
| オーナー確認が無い | `FAILED_PRECONDITION` | 変えない | 「Google でオーナー確認が済んでいない店舗です」 |
| 再連携が必要 | トークンの更新で `invalid_grant` | **口コミの処理からは変えない**（アカウント単位の判定は、既存の予約通知の定期処理に任せる。`recordGoogleAuthResult` を呼ばない） | 「Googleとの連携の確認が必要です。［再連携する］」 |
| 原因不明・一時的 | それ以外の403・429・5xx・時間切れ・通信 | **変えない** | 「時間をおいてもう一度お試しください」 |

- 実際の応答の形（理由の値）は、§6-3 の実店舗の読み取りで確かめ、分類を見直す。
- **検証**：原因不明の403・店舗の権限が無い403・API の設定の問題で、口コミの結び付け・`google_accounts.auth_state`・Gmail の結び付けが変わらない。権限不足の403で、口コミの結び付けだけが変わり、Gmail の結び付け・予約メールの取得の対象（`notifications_list_pollable_salons`）が変わらない。

### 第2段階
- 新着の自動検知（Notifications API・Pub/Sub）と定期的な照合・定期同期、送信後の状態の定期確認。
- 口コミの LINE 通知：master の通知先（0023 の招待・解除・登録の世代、`line_connections` の id を作り直さない）を使う。配信の状態・停止の条件・重複防止は口コミ専用の表で持ち、予約通知（0020 の `notification_deliveries`・予約の停止区間）と混ぜない。0023 の `line_recipient_stop_review_notifications` に合わせた表の形にする。★と抜粋（G2）は投稿者名なし。

---

## 4. 店舗登録（PR #9）との依存関係、ブランチと migration

**依存を2つに分ける**
- **登録側のコードへの依存（開発に必要）**：利用可否の判定（0025 の `salon_feature_access` と利用区分）、型（`OwnerSalon.serviceStatus`、`FeatureAccessInput.serviceActive` など）、入口の順番（`resolveNextStep`）。口コミの統合（利用可否・入口・設定）はこれを土台に作る。
- **本番デプロイへの依存（マージと公開にだけ必要）**：PR #9 が master に入り、本番に 0025・0026 が適用され、デプロイされたあとでなければ、口コミの PR はマージ・公開しない（土台のコードが本番の DB を前提にするため）。
- → **開発・検証を始めるのに、PR #9 の本番適用を待つ必要はない**。

**先行して統合・検証する方法**
1. 新しい worktree `review-app-inbox`（新しいブランチ `feature/reviews-inbox`）を、**PR #9 のコミット済みの先頭（`origin/feature/salon-onboarding` b7e5681）**から作る。`review-app-onboarding` の未コミットの作業（0026 など）には触れず、取り込みもしない。
2. 取り込み元は `review-app-reply`（07d8fa6）。§1・§3 で残すとしたファイルだけを移す（マージはしない）。
3. 最初のコミットで `vercel.json` にこのブランチの Preview の停止を足す（PR #9 の設定と同じ箇所に追加）。push はその後。
4. 検証は隔離した環境で行う
   - **localdb**（手元の PostgreSQL 16。ポート 54329 で稼働中。PR #9 の `scripts/localdb` と `npm run test:localdb`）：0001〜0025 と口コミの migration を適用し、DB 関数・ロック・同時実行・世代の確認・期限の削除を確かめる。共有テストDBに触れない。
   - 画面（ログインを含む）：架空の Google と、Supabase の認証が要る。§7-3 で、口コミ専用のテスト用プロジェクトを作るか、共有テストDBを片付けて使うかを決める。
5. PR #9 が更新されたら（0026 のコミットなど）載せ直す。PR #9 が master に入ったら master に載せ直す。番号と、同じ関数への変更をそのたびに見直す。

**migration**
- 番号は **0027 から**（0025・0026 は PR #9）。古い 0013〜0017 の番号は使わない。着手のたびに最新の番号を確かめる。
- 案：0027 返信の設定（旧0013）／0028 ロケーション（世代・`google_account_id` 基準）・同意・口コミの一時保存（旧0015 の必要部分＋旧0016、`gbp_upsert_reviews` の処理権の確認を追加）／0029 返信の操作（旧0017＋送る直前の利用可否・世代の確認）／0030 `google_reviews` を `feature_catalog` に追加（`coming_soon`、プランの規則は標準で使えない）。
- 適用済み（0001〜0024）は書き換えない。0024・0025・0026 の関数（`salon_feature_access`・`admin_list_salons`・`salons_client_write_guard` など）は作り直さず、行を足すだけ。何度実行しても同じ結果になるように書く。
- 第1段階では LINE の表（旧0014）は作らない。
- 共有テストDB（以前の口コミの検証と同じプロジェクト）には古い 0013〜0017 の表・関数が残っている。そこを使う場合は、片付けの対象と影響を示して確認してから（§6-2）。

---

## 5. 既存の機能への影響
- **口コミ収集**：アンケート・お客様用リンク・Google口コミURL・お客様の画面は変えない。タブは `google_reviews` を使える店舗にだけ出る。
- **予約通知**：開始・停止・再開の経路、`lib/notifications/**`、Gmail の結び付け、`reservationActivationPaths.test.ts` は変えない。口コミの連携・停止・店舗の変更・失敗の記録は Gmail の結び付けとアカウントの状態を変えない（§3-B）。テストで確かめる。
- **無料・テスト店舗**：プラン・提供状態・店舗ごとの許可・利用区分に従う。標準は使えないので、許可するまで変わらない。
- **既存店舗の本番の許可**：今回は変えない。公開のとき、運営管理で店舗ごとに許可する。
- **運営管理**：`google_reviews` が DB の機能一覧に入るので、利用権限の編集画面に「届いた口コミ」が出る（運営担当者にだけ見える）。
- **`listed`**：**false のまま**。true にすると、SalonPack プランのホームに「届いた口コミ」のカード（準備中なら灰色）、設定の画面に Google 連携のカードとリンクが新しく見えるため（メニューは変わらない）。入口は「口コミ」のタブだけ。設定の Google 連携の画面の口コミのカードは「使える店舗だけ」で出す。

---

## 6. 検証方法と公開までの手順
1. **ローカル・架空データ**：単体テスト（移植＋新規：トークンの注入、§3-A の重なり、§3-B の分類、期限の削除が利用可否に関係なく動く、各入口が `coming_soon` で拒否、貼り付け型の入口が無い、新着の各場合、数字を0にしない、未返信と結果不明の区別）、型・lint・build、localdb（`npm run test:localdb`）、架空の Google での画面確認（PC 1280px・スマホ 390px）。
2. **テスト用DB**（§7-3 で決めた環境）
   - `.env.testdb.local` の `TEST_DATABASE_URL` を Session pooler に差し替える（直接の接続先は IPv6 だけで使えない）。
   - 共有テストDBを使う場合：古い 0013〜0017 の表・関数の片付けの対象と、ほかの作業（PR #9 のテスト・予約通知のテスト・0023 の関数）への影響を示してから確認を取る。
   - 口コミの migration を適用し、実接続のテスト（同時実行・二重防止・同期・世代）と画面の確認。
3. **許可された実店舗での読み取り確認**：`salonpack-gbp` に手元用の OAuth クライアント（リダイレクト URI `http://localhost:3200/api/google/oauth/callback`）をご本人が作り、手元のサーバーとテスト用DBで、Lavi の管理者の `salonpack.app@gmail.com` で連携 → 取得 → 一覧・詳細だけ。本物の応答の形（`reviewReplyState`・`averageRating`・写真・エラーの理由）を確かめる。投稿しない。事前に Lavi に知らせる。
4. **個別に了承された内容だけでの返信の確認**：口コミと文章を Lavi に確認してもらってから1件ずつ。削除も了承を取ったときだけ。今回は行わない。
5. **本番**：PR #9 のマージと 0025・0026 の本番適用 → 口コミの migration の適用（事前・事後の確認の SQL）→ 口コミの PR のマージ（非公開のまま）→ 期限の削除の定期実行 → プライバシーポリシー・同意文の更新 → §7-1 の確認 → `GOOGLE_REVIEWS_OAUTH_ENABLED=1` → 提供状態を `available` → 運営管理で Lavi から店舗ごとに許可。

**非公開でマージするときに保証する条件**（DB が無いことには頼らない。migration はマージの前に適用する）
- 提供状態が `coming_soon`（DB の `feature_catalog`）→ `salon_feature_access` が全店舗で「使えない」→ 画面・操作・API・生成・投稿・同期がこの判定で止まる（テストで確認）。期限の削除だけは判定に関係なく動く（§3-9）。
- `GOOGLE_REVIEWS_OAUTH_ENABLED` が空 → 口コミの権限を Google に求めず、GBP の処理も動かない（二重の停止）。
- 提供状態を変えても、標準は「使えない」ので、店舗ごとの許可が無ければ使えない。
- `listed:false` → ホームのカード・メニューは増えない。

**その他**：本番DBにつながる Preview は使わない（新しいブランチは Preview を止めてから push）。実際の返信の投稿・削除、メール・LINE の送信は、今回も検証の 1〜3 でも行わない。

---

## 7. 利用者の判断が本当に必要な未確定事項
1. **Google の規定との関係（未確認。ご本人の判断の記録は適合確認の代わりにしない）**
   - 原文：「You can store limited amounts of Content only to improve the performance of your project.」「It must be stored temporarily for no more than 30 calendar days.」「It cannot be manipulated or aggregated in any way.」（Policies、2026-08-28）
   - 確認が必要なこと：(a) 連携した店舗の口コミを表示のため最長25日一時保存すること（「limited amounts」との関係）、(b) 保存した口コミを「未返信」などで絞り込むこと、(c) 未返信件数の表示（保留中）、(d) 新着件数と、そのための識別子（HMAC）と日時を25日より長く持つこと。
   - 確認の方法（例：Business Profile API のサポートへ書面で質問する）を決め、公開（§6-5）の前に済ませる。否定的な場合の代わり（件数・絞り込みなし、一時保存しない設計など）はそのときに決める。
2. **PR #9 のマージと本番適用の時期**：口コミの PR をマージ・公開できる時期を左右する（開発・検証の開始は待たない）。
3. **画面の検証に使う Supabase**：口コミ専用のテスト用プロジェクトを新しく作る（共有テストDBに触れない。作成はご本人）か、共有テストDBの古い表を片付けて使う（§6-2 の確認が必要）か。
4. **プライバシーポリシー・同意文の文言**：Google の口コミの一時保存（25日）・AI（OpenAI）での処理・返信は明示的な操作だけ、の追記（法務の確認を含む）。
5. **期限切れの削除の定期実行**：外部のスケジューラーの設定（ご本人の作業。公開の前に必要）。

（参考・別件）予約通知の Gmail の権限（制限付き）は未承認のまま。口コミだけの店舗には関係しない。

---

## 主なファイル
- 移植（`review-app-reply` → `review-app-inbox`）：`lib/replyGeneration/*`（`offline.ts`・`draftMemory.ts` を除く）、`lib/gbp/{apiClient,mapping,replyText,source,store,supabaseStore,memoryStore,runtime,backend,simulated}.ts`、`lib/googleReviews/*`、`components/reviews/inbox/*`（`PasteBackLink` を除く）、`components/reviews/settings/ReplySettingsForm.tsx`、`components/reviews/ReviewsSubNav.tsx`、`components/ui/{Avatar,Dialog,EmptyState,LeaveGuard,StarRating}.tsx`、`app/dashboard/reviews/google/*`（`paste` を除く）、`app/dashboard/reviews/settings/*`、`app/api/jobs/gbp-maintenance`。
- 新規：`lib/replyGeneration/service.ts`、新着件数の RPC、店舗の選択（世代）の RPC、GBP のエラー分類、migration 0027〜、localdb のテスト（`scripts/localdb/reviews*.test.ts`）。
- PR #9 の土台の上で変更：`lib/features/registry.ts`（`google_reviews` を catalog に）、`lib/features/homeCards.ts`（入口）、`app/dashboard/reviews/page.tsx`（タブ・アンケート未作成）、`app/dashboard/settings/google/{page,actions}.ts(x)`（口コミのカード・店舗の選択・停止での削除）、`lib/google/oauthFlow.ts`（戻り先に口コミ）、`vercel.json`。
- 再利用する仕組み：`obtainGoogleAccessToken`、`bindGoogleFeatures`/`unbindGoogleFeatures`、`markBindingScope`、`classifyGoogleError`、`startGoogleConnect`（`add_scope`）、`resolveFeatureSalon`/`canAccessFeature`、`salon_feature_access`、`gbp_purge_salon_content`/`gbp_purge_expired_content`、`BlogSubNav` の形、`scripts/localdb/db.ts`。

## 検証（実装後）
- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .`、`npm run build`、`npm run test:localdb`。
- テスト用DB：状況の確認 → 承認後に適用 → `npm run test:testdb`、画面の確認（架空の Google、PC・スマホ）。
- 境界：`lib/notifications/**`・0009〜0026・予約通知の開始/停止/再開・hmail の差分が0。`reservationActivationPaths.test.ts` が通る。口コミの処理の失敗で Gmail の結び付け・アカウントの状態が変わらない。
