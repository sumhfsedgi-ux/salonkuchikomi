# 口コミ465 次期機能 調査・設計PLAN（v3）

> v2（2026-10-03 承認）に、2026-10-04 に決まったことを反映した版。v2 の作成時は、コード変更・migration・外部サービス設定変更は行っていない（hmailは読み取りのみ）。
> 各 Phase は、§11 の確認事項への回答と着手の指示を受けてから始める。
> 「口コミ465」は、口コミ機能だけを使える契約プラン（`salons.plan = 'reviews'`）の名前。画面のブランドは常に「SalonPack」（§0）。

## v3での変更（2026-10-04 の決定）
| # | 決定 | 反映先 |
|---|---|---|
| 1 | 構成は **1 Vercel Project / 1 Deployment / 1 codebase**。店舗ごとの機能は `salons.plan` で切り替える。APP_MODE は「将来別デプロイを作る場合の上限」として残し、削除・fail-closed化・plan への置き換えは別タスク | §0、§1-4、§2、§4-2、§6、§10 |
| 2 | 画面のサービス名・ロゴは plan に関係なく常に「SalonPack」。「口コミ465」は契約プランの名前 | §0、§3-4、§4-1、§8（通知の文面） |
| 3 | **中立・否定の選択肢は追加しない**（新しいテンプレートにも既存店舗にも）。ただし次は**必須ルール**：自由記述・「その他」に出た否定的な内容を削除しない／ポジティブに反転しない／不自然に弱めない／回答にない満足表現を足さない／review gating をしない／全員に同じGoogle口コミの導線を出す | 結論サマリー、§1-2、§2、§6、§7-1、§8〜§12、§13 |
| 4 | Phase 0 は完了（master e80e8a6）。0011 は本番に適用・検証済み。Next.js は 16.3.8 に更新済み（master e59f080） | §5、§9、§12 |
| 5 | Phase 1 の詳細な実装計画を追加 | **§13** |
| 6 | **生成の方針を変更（v3.1）**：事実は作らない。ただし感情・温度感・主観的な反応は、回答と矛盾しない範囲で積極的に補ってよい。「回答にない満足表現を足さない」「回答より感情を強めない」は廃止。目標は「アンケートの要約」ではなく、本人が体験を思い返して気持ちを込めて書いたような口コミ。Linter は事実の捏造・効果の捏造・極端な感情・要約だけ・主観の無さ・文型の均一さを判定する | §7-1、§13 |

## v2での主な変更（ご指摘10点の反映先）
| # | ご指摘 | 反映先 |
|---|---|---|
| 1 | 「技術的に可能」と「マルチテナントSaaSとして許可される」を分け、断定しない | §3-1 / §3-2、Gate **G1**（Phase 3 の開始条件） |
| 2 | 口コミ本文のOpenAI送信・LINE抜粋を「要確認」から外し Gate にする | Gate **G2**（§3-4）。確認が取れるまで LINE は最小文面にし、一覧からのAI返信は出さない |
| 3 | 中立・否定の選択肢を Phase 1 の必須課題にする。review gating の禁止、投稿前の本人確認UX（**v3 で変更**：選択肢は追加しない。gating の禁止と本人確認UXは維持） | §7-1「アンケートとCTA」、§8、§9 |
| 4 | source_ids だけでは意味の整合を保証できない | §7-1「source_ids の限界」と検証方式の比較。推奨は**危険ケースのみ同期で意味検証** |
| 5 | unique(owner_id) を必須修正から外す | §5（削除）。代わりに将来の拡張を妨げない店舗コンテキストの解決案を記載 |
| 6 | reviewReplyUrl をキャッシュするか、押したときに取得するか | §5 google_reviews、§6 |
| 7 | 有効化するAPIの数を固定しない | §3-1 |
| 8 | Vercel Hobby の cron 制約は今回の15分同期には当たらない | §3-6 |
| 9 | 既存ブランチは再利用せず、最新 master から新しいブランチを切る | §9 冒頭 |
| 10 | 今すぐ／承認前／承認後の3分類 | §12 |

## 結論サマリー
1. **最初に直す既存の穴**：店舗オーナーが自分の `salons.plan` を書き換えられる。Phase 0 で塞ぐ（1オーナー1店舗のDB制約は入れない）。→ **完了**（0011 を本番に適用・検証済み）。
2. **A（口コミ生成）**
   - プロンプトにはルールがすでにほぼ入っている。問題は仕組みのほうなので、作り直す。
     - 素材の整理と構成決定はコードで行う。
     - LLMの生成は1回にする（各文に出典を付ける）。
     - 出力はコードの Linter で検査する。
     - 効果の断定・医療・ネガの反転など**危険なケースだけは同期で意味を検証**する。
   - アンケートに中立・否定の選択肢は**追加しない**（v3）。そのかわり、自由記述・「その他」に出た否定的な内容を削除・反転・不自然に弱めないことを、コードの検査と意味検証で保証する（v3.1：事実は作らないが、気持ち・温度感は回答と矛盾しない範囲で補ってよい）。review gating はしないことを明文化し、投稿前に本人が確認するUXにする。
3. **B（Google口コミ）**：取得・新着検知・返信投稿は公式APIで**技術的には可能**。ただし、口コミ465のような**マルチテナントSaaSとしてこの運用が許可されるかは未確定**。→ API利用申請の際に具体的なユースケースを示して確認すること（**G1**）を、Phase 3 の開始条件にする。
4. **取得した口コミ本文をOpenAIへ送ること、LINEに抜粋を載せること**は **G2** を通るまで行わない。それまで LINE は「新しいGoogle口コミが届きました／SalonPackで確認する」だけにする（v3：サービス名をブランドの決定に合わせた。Phase 4 で最終確認）。
5. **C（LINE通知）**：hmail の予約通知とは別の、**口コミ通知専用の公式アカウント**と新しいテーブルを使う。plan を変えても再連携は起きない。
6. **順番**：0 安全（完了）→ 1 口コミ生成（§13）→ 2 貼り付け型AI返信 →（G1）3 Google連携・一覧 → 4 LINE通知（文面は最小）→（G2）本文を使う機能 → 5 Googleへ直接返信。§12 に3分類をまとめた。

## 0. 現在の構成（v3 で追加）
- **1 Vercel Project（SalonPack）/ 1 Deployment / 1 codebase**。口コミ465用の別プロジェクト・別ドメインはない。
- 店舗ごとの機能は `salons.plan` で切り替える。`reviews`（口コミ465）は口コミ・設定、`salonpack` は口コミ・ブログ・予約通知など。判定は `lib/access/*`（`requireFeatureAccess`・`filterNavItemsByPlan`）が行う。
- 画面のサービス名・ロゴは常に「SalonPack」（`lib/brand.ts`）。
- `NEXT_PUBLIC_APP_MODE` は本番では未設定（salonpack 扱い＝全機能を提供）の想定で、店舗ごとの制御には関わらない。`reviews` にするとデプロイ全体でブログ・予約通知が止まるので設定しない。整理は別タスク。
- plan を reviews → salonpack に変えても、ドメイン・ログイン・お客様URL・連携（Google・LINE）はそのまま使える。

## Context
- 口コミ465は現在、“集める”機能（アンケート → AI口コミ文 → Google投稿画面へ）だけ。これを「集める → 自然な文章にする → 気づく → 返信する」まで広げる。
- 既存ユーザー・SalonPack・hmail本番（同一Supabaseを共有）・既存の口コミ生成を壊さない。アップグレードで再連携を起こさない。
- 調査範囲：review-app 全体、hmail と blog-app（読み取りのみ）、Google / LINE / Vercel / OpenAI の公式ドキュメント。調査結果は設計レビューでもコードと照合済み。
- リポジトリから確認できなかったもの：本番DBの状態（0009/0010の適用、hmail移行）、Vercelの環境変数とプラン、cron-job.org の設定、Google Cloud同意画面の状態、LINEチャネルの設定。
- **調査中のリポジトリの変化**（このセッションでは操作していない）
  - 別セッションが f6179cb「ナビ表示も店舗の契約プランで出し分けるよう修正」を `feature/reviews-465-v2` に commit した。
  - そのブランチを `master` へマージした（83e80e5）。`origin/master` も同じコミットになっている。
  - 現在は `master` をチェックアウトしている。本PLANはこの変更を前提にしている。

---

## 1. 現状コード調査結果（パスは review-app/ 基準）

### 1-1 口コミ生成（A）
- **呼び出し経路**：`ReviewFlow.tsx` から `POST /api/generate-review`（`app/api/generate-review/route.ts`）へ送る。**認証・レート制限・DB照合はなし**。
- **入力**（:7-30）
  - `salonId`：形式チェックのみで、ログ以外では使っていない。
  - `answers[{question, answer}]`：**質問文もクライアントが送る**。
  - `salonName` / `businessType` / `previousReview`：previousReview はお客様が編集できる文章。3つとも **system prompt に埋め込まれる**（:97-127）。
- **OpenAI呼び出し**（:279-333）
  - fetch で Chat Completions を直接呼ぶ。モデルは `OPENAI_MODEL`（実際の値は未確認）。
  - `temperature 1.0`。出力はプレーンテキスト。タイムアウト30秒。
- **プロンプトの中身**（:139-217）：要望の大半は**文言としてはすでに入っている**。
  - 未回答の事実を追加しない、医療効果を断定しない、来店理由≠結果、ネガを消さない。
  - 主役1〜2個、質問順にしない、語尾を多様にする、避けたい表現リスト、内部セルフチェック。
  - → AIっぽさは**文言ではなく仕組みの問題**。
- **多様化の仕組み**
  - 構成の指示をランダムに選び、再生成時は必須化している（:47-53）。回答に合わない構成を強制することがある。
  - 例文15件から3件を入れている（:63-90）。ただし例文自体が回答にない状況（仕事帰りに／友人にすすめられて…）と、避けたい表現を含んでいる。
- **後処理**：`trim` と、拒否文・カフェ系の正規表現に当たったときの1回再生成だけ。
- **永続化**：何も保存しない（0007 で方針として明記）。再生成時には生成した全文をログに出している。

### 1-2 アンケートのデータ構造・自由記述
- **テーブル**（0001）：`surveys` / `questions(question_text, question_type single|multiple|text, required, max_selections, sort_order)` / `question_options`。**役割メタデータはない**。
- **質問IDは保存のたびに変わる**：`save_survey_questions` が全削除してから再挿入する（0007:30-54）。お客様ページが送るのは選択肢の**文字列**。
- **回答の扱い**
  - 「その他」の詳細は `その他（詳細）` に結合（最大80字）。自由記述は最大300字。
  - 送信時は `質問文: 回答` の行を質問順に連結するだけ。
- **既定テンプレート6種**（seed.sql）
  - 質問は「来店回数／来店理由／施術後の体感／施術の感想／スタッフ・店内／自由記述（任意）」。
  - **選択肢はすべて肯定〜中立で、「特になし」も「気になった点」もない**。ネガティブな体験は自由記述でしか表せない。
  - v3：選択肢は追加しない。否定的な内容は自由記述と「その他」の詳細から入る前提で、生成側で必ず保持する（§7-1）。
- **業種**：`business_type` はテンプレート名から自動補完され、プロンプトに入る。

### 1-3 画面・Server Actions
- **お客様ページ** `app/review/[slug]/page.tsx`
  - anon で `salon_public` ビューと有効なアンケートを読む。
  - CTA「Google口コミを書く」は `google_review_url` へのリンクで、押すと文章もコピーされる。**クリックは記録していない**。
  - **全員に同じCTAを出している（review gating なし）**。
- **管理画面** `/dashboard/reviews`：お客様用リンク、Google口コミURL、質問編集、テンプレから作り直し。

### 1-4 salons / plan / APP_MODE / feature access
- **`lib/appMode.ts`**：reviewsモードの Feature は `[reviews, settings]`。`NEXT_PUBLIC_APP_MODE` が未設定・誤りだと salonpack 扱いになる（**fail-open**）。→ 1デプロイ構成（§0）ではこれが正しい既定値なので、変更しない（v3）。
- **`lib/access/plan.ts`**：plan=reviews は `[reviews, settings]`、salonpack は全機能。
- **`lib/access/featureAccess.ts`**：mode ∧ plan ∧ permission（permission は常に true のスタブ）。
  - blog と notifications には適用済み。
  - reviews / settings と `/api/generate-review` は未適用。
- **ナビ**：f6179cb 以降、`filterNavItemsByPlan` で plan でも出し分けている。→ 新しい Feature キーは PLAN_FEATURES にも入れる必要がある。
- **店舗の解決**：`getCurrentSalon` は profiles→salons を embedding して `salons[0]` を返す（ORDER BY なし）。`owner_id` に unique はない。`createSalonAction` は既存店舗の有無を確認しない。
- **ブランド表示**：v2 の調査時は、reviewsモードで「口コミ365」と表示する分岐があった。→ Phase 0 でなくし、常に「SalonPack」にした（v3）。

### 1-5 通知・LINE・cron・hmail統合
- **0009 の6テーブル**：service role 専用（RLS有効・ポリシー0）。
- **`line_connections`**：予約通知専用で、チャネルや用途を表す列がない。
- **LINE送信**（`LineClient.ts`）：単一の `LINE_CHANNEL_ACCESS_TOKEN`（hmail と同じチャネル）を使う。`pushText` のみで retry key はない。
- **連携フロー**：review-app には LINE webhook・連携コード・Google OAuth の開始/コールバックがない。hmail にのみある（連携コード `HP-XXXXXXXX`、salonIdだけを署名した OAuth state）。
- **cron**：`POST /api/cron/notifications/poll-mail`（cron-job.org から呼ばれる）。ロックなし、取得は at-most-once、再送は最大3回/24h。`vercel.json` は regions のみ。
- **hmail**：同一Supabaseの `hmail` スキーマで本番稼働中。移行は未実行。Google OAuth クライアントと LINE チャネルは共用。Gmail の同意画面（restricted）は未審査。

### 1-6 DB / RLS / service role
- **【重大】** salons の `owner_update` / `owner_insert` が全列を許可している（0003:42-49）。→ `plan` を書き換えられる。
- **`salon_public` ビュー**：全店舗の公開列を anon に公開している（新しい識別子はここに足さない）。
- **service role**：`lib/blog/admin.ts` と `lib/notifications/admin.ts`（重複。`server-only` なし）。
- **RPC**：Supabase の既定では anon からも実行できる。
- **blog の DDL**：review-app にはない。
- **テスト・CI**：ない。

### 1-7 流用できるもの
- **`callOpenAIJson`**（lib/blog/openai.ts）：json_schema strict 対応。
  - 注意：モデルが全体で1つ、`max_tokens` を送る、usage を返さない、パース失敗時に生の出力をログに出す。
- **blog の2段構成**（生成 → AIっぽさチェック）、**`variety.ts`**（直近と被らない選択）、**Style Profile**（文体の構造化）。
- **排他ロック**：`salon_settings.generation_locked_at` の条件付きUPDATE。fail-open なので cron では真似しない。
- **その他**：`BlogSubNav`、`copyToClipboard`、`useAutosizeTextarea`、`formatDateTimeJST`、hmail の `buildLineAddFriendLink`、`import "server-only"`。

### 1-8 UI
- **レイアウト**：`DashboardShell`（PCはサイドバー、モバイルは下部ナビ2列）。トークンは ivory/sage 系。
- **選択状態の判定**は前方一致なので、`/dashboard/reviews/*` にページを足しても「口コミ」が選択状態になる。
- **ルート名の注意**：proxy は先頭が `review` で始まるパスを対象外にしているので、新しいルートはルート直下の `/review*` に作らない。

---

## 2. 現在の問題点・技術的負債（今回の機能に関係するもの）
| 重大度 | 問題 | 根拠 | 新機能への影響 |
|---|---|---|---|
| 解決済み（重大） | オーナーが `salons.plan` を変更・指定できる | 0003:42-49, 0010 | **Phase 0** で修正し、0011 を本番に適用・検証済み（2026-10-04） |
| **高** | アンケートの選択肢が肯定〜中立だけ（中立・否定を表す選択肢がない） | seed.sql | 体験に基づかない、良い面だけの口コミになりやすい。→ 選択肢は追加しない（v3）。否定的な内容は自由記述・「その他」からだけ入るので、**それを生成で必ず保持する**ことを Phase 1 の必須要件にする（§7-1） |
| 高 | `/api/generate-review` が認証もレート制限もない OpenAI 中継 | route.ts:5-30 | コスト乱用 |
| 高 | クライアントの質問文・前回文章を system prompt に埋め込んでいる | route.ts:97-127 | インジェクションと品質劣化 |
| 高 | 品質担保が自己チェックだけで、出力を検査していない／例文が捏造を誘発する | route.ts:63-79, 206-217 | 捏造・定型句 |
| 中 | 質問IDが保存のたびに変わる | 0007:30 | 回答は ID→質問文→選択肢文 の順で照合し、FK を張らない |
| 中 | 店舗の解決が曖昧（`salons[0]`・ORDER BY なし／作成時の重複チェックなし） | queries.ts:53, dashboard/actions.ts | 新テーブルの salon_id が不定になる → Phase 0 で決定的にした（DB制約は入れない） |
| 低 | APP_MODE が fail-open | appMode.ts:21 | 1デプロイ構成では正しい既定値（v3）。`reviews` に設定すると全店舗でブログ・予約通知が止まる点だけ注意。整理は別タスク |
| 中 | LINE連携・OAuth がない／`line_connections` が用途を区別しない／Google クライアントが hmail と共用 | 0009, .env.example | **別テーブル・別チャネル・別GCPプロジェクト** |
| 中 | cron にロックがない・at-most-once・再送が CAS なし | pollMailForSalon.ts | 口コミ通知では真似しない |
| 解決済み | 名称が「口コミ365」 | brand.ts:10 | Phase 0 で常に「SalonPack」にした（v3） |
| 低 | テストと CI がない、blog の DDL がない、ドキュメントが古い | — | Phase 0 で vitest を導入済み。CI はまだない |

---

## 3. Google口コミ連携：技術的な可否と、運用の許可を分けて評価（公式ドキュメント 2026-10-03 確認）

### 3-1 技術的に可能か（API仕様）
| 項目 | 判定 | 根拠（公式） |
|---|---|---|
| 口コミ取得 | 技術的に可能（API承認が前提） | v4 `GET mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews`、pageSize最大50、orderBy `updateTime desc` |
| 複数店舗をまとめて取得 | 可能 | `POST .../locations:batchGetReviews` |
| 新着検知 | ① ポーリング ② Pub/Sub（`NEW_REVIEW` / `UPDATED_REVIEW`） | 通知設定は**アカウント単位でトピックは1つ** |
| リアルタイム性 | ポーリングは間隔次第。Pub/Sub の遅延の保証値は記載なし | |
| 返信取得 | 可能 | `reviewReply {comment, updateTime, reviewReplyState, policyViolation}`（state は 2026-04-01、policyViolation は 2026-07-01 に追加） |
| 返信画面のURL | 可能 | **`reviewReplyUrl`**（2026-07-24 の changelog：get / list / batchGetReviews で取得可能） |
| 返信投稿・削除 | 技術的に可能（認証済みの店舗のみ。審査あり） | `PUT/DELETE .../reviews/{r}/reply`、4096 bytes まで |
| OAuth | `business.manage`（＋`openid email`）、offline | business.manage が sensitive かどうかは Cloud Console の同意画面で確認する |
| Google Cloud 設定 | API利用申請が必須。承認前は0 QPM、承認後は300 QPM。サンドボックスはない | 申請条件：60日以上「認証済み＋有効」なGBPを管理／GBPにWebサイトが載っている／オーナーか管理者のメール |
| 有効化するAPI | **申請・承認時点の公式ドキュメント（Basic setup）の列挙を正とする** | 2026-10-03 時点の記載は「seven APIs」だが、固定値として扱わない |
| クォータ | 300 QPM/プロジェクト（全店舗の合計）。v4 reviews 個別の枠と「10 edits/min/GBP」の適用は**承認後に確認** | |
| 店舗情報 | Business Information API（readMask 必須） | `metadata.placeId / newReviewUri` |
| SDK | googleapis 174.0.1 には v4 の口コミAPIがない（v1 の Account Management / Business Information / Notifications はある） | → 口コミは fetch で直接呼ぶ（ローカルで確認済み） |

### 3-2 マルチテナントSaaSとして許可されるか（**未確定。Gate G1**）
**公式ポリシーの記載**（Business Profile APIs policies の Prohibited practices。原文のまま）
- 「You cannot allow agencies, end-clients, or other third parties to use your Business Profile project, or your own APIs, in a way that allows those third parties to avoid applying for their own Business Profile project.」
- 「Any automatic or programmatic use of Business Profile by agencies or end-clients requires them to use their own Business Profile project.」
- 「You cannot provide indirect access to your Business Profile project.」
- 「End users of your Business Profile APIs need to manually sign in to use it. They're not allowed automatic access to make manual or programmatic changes to their accounts.」

**一方、OAuthの公式資料の記載**（Implement OAuth。原文のまま）
- 「Establishes that a partner platform or application can access and modify location data with explicit consent from the business owner.」
- 「Enables partner platforms to perform online or offline actions on behalf of the business owner.」

**評価**
- 2つの記載の関係は、公式資料だけでは断定できない。具体的には次の点が未確定。
  - 運営者の1つのプロジェクトに、各サロンが OAuth 同意する形でよいか。
  - 定期的な自動取得が「indirect access」や「automatic or programmatic use by end-clients」に当たらないか。
- よって **「1つのGCPプロジェクトを申請し、各サロンがOAuth同意すれば問題なくSaaS提供できる」とは断定しない**。

**Gate G1（Phase 3 の開始条件）**：API利用申請のときに、次のユースケースを具体的に示し、この運用が許可されることを確認する（回答は記録として保存する）。
- 口コミ465は複数のサロン向けのSaaSである。
- 各サロンが自分のGoogleアカウントで明示的に OAuth 接続する（手動でサインインする）。
- 定期的に口コミを取得する（読み取り）。
- 新着の口コミを検知する。
- AIで返信案を作る（G2 の論点も同時に確認する）。
- 返信の投稿は、ユーザーが1件ごとに明示的に操作する。
- 自動返信は行わない。
- 当方の順守事項として次も添える：取得データは30日以内のキャッシュにとどめて集計しない／アカウントを変更したら48時間以内に通知する／解約時は7営業日以内に連携を解除できるようにする。

**G1 が通るまで行わないこと**：実際のサロンでの OAuth 接続、定期同期、口コミデータの保存、それらの本番実装（§12-C）。
- 回答が「各サロンが自分のプロジェクトを持つ必要がある」など否定的だった場合：B〜D は「貼り付け型のAI返信（Phase 2）」と「Googleの返信画面を開く導線」の範囲にとどめ、設計を見直す。

### 3-3 ポリシー上の制約（設計に直結）
- **保存の制限**：取得データの保存は、限定量・性能改善目的・**30日以内**・安全に保存・**加工/集計は不可**。→ 25日のキャッシュにし、パージする。
- **返信の同意**：代理返信には店舗の事前承認が必要。事前の明示的な同意なしの自動返信は禁止。
- **変更の通知・解約時**：アカウントを変更したら48時間以内に通知する。解約時は7営業日以内に連携を解除できるようにする。
- **Maps のコンテンツポリシー**：review gating・見返り（金銭・特典）・体験に基づかない内容は禁止。
- **refresh token の失効**：取り消し、6か月使われない、100本を超える、**同意画面が Testing のまま（7日で失効）**。

### 3-4 Compliance Gate G2（取得した口コミ本文の外部送信）
**対象**
- APIで取得した口コミ本文（と投稿者名）を **OpenAI に送って AI返信を作ること**。
- **LINE 通知の本文に抜粋を載せること**。
- どちらもポリシーに明記がないため、G1 の申請時に合わせて確認する。確認が取れるまでは**行わない**。

**G2 が通るまでの仕様**
- **LINE 通知**：口コミ本文・投稿者名・★を載せない。
  ```
  新しいGoogle口コミが届きました
  SalonPackで確認する ▶ https://…/dashboard/reviews/google
  ```
  複数件のときは「新しいGoogle口コミが3件届きました」とする。低評価の強調も G2 の後に行う。
- **届いた口コミの一覧**：「AIで返信を作る」は出さない（取得した本文をOpenAIへ送る導線を作らない）。出すのは「Googleで返信する」（reviewReplyUrl）とコピーだけにする。
- **貼り付け型のAI返信（Phase 2）**：オーナーが自分で入力する文章を使うもので、API経由のデータではない。そのため G2 とは切り分ける。ただし一覧から自動で流し込む機能は作らない。

### 3-5 SaaS提供時の注意点（G1 で許可された場合の前提）
- **クォータ**：300 QPM は全店舗の合計。15分間隔で約1,500店舗までを目安にする。超える場合はクォータ増加か Pub/Sub。
- **Pub/Sub**：アカウントにつき1トピックなので、他ツールと衝突する。→ ポーリングを主にする。
- **アカウントの権限**：連携するアカウントは、その店舗のオーナーか管理者である必要がある。同意画面は本番公開が必須。
- **イベントを分ける**：「口コミ465で生成した」（自社イベント）と「Googleに投稿された」（APIで観測した事実）は別イベントとして扱う。両者を突き合わせて推定する処理は作らない。

### 3-6 LINE / Vercel（公式）
- **LINE**
  - userId は provider 単位で発行される。
  - push に `X-Line-Retry-Key`（UUID、24時間有効）を付ければ二重送信を防いで再送できる。同じキーの再送は 409 になる。
  - グループに送ると、通数はメンバーの人数分かかる。
  - 月間の上限は公式アカウント単位。料金は無料200通／5,000円・5,000通／15,000円・30,000通、追加は3円/通。
  - webhook は署名（HMAC-SHA256）で検証する。URLはチャネルごとに1つ。
- **Vercel**
  - 口コミの同期は **cron-job.org から15分ごとにHTTPで呼ぶ**。そのため「Hobby の Vercel Cron は1日1回」という制約は、**今回の15分同期の技術的な制約にはならない**。関数の最大実行時間（現行のドキュメントでは Hobby でも300秒）も、45秒で区切るバッチなら制約にならない。
  - ただし **Hobby は非商用に限られるので、SalonPack（口コミ465プランを含む）を商用で提供するなら Vercel Pro が必要**。
  - cron-job.org 側の呼び出しも、抜けや重複が起こり得る前提で設計する（ロックと reconciliation）。

---

## 4. 推奨アーキテクチャ

### 4-1 データフロー（Gate の位置を明記）
```
【集める・自然な文章にする】（同期処理。お客様がスマホで待つ）
/review/[slug] ──回答──▶ POST /api/generate-review
  ① 店舗と有効なアンケートをDBで確認し、回答を照合（ID→質問文→選択肢文）。レート制限
  ② 素材シート（コード。自由記述・「その他」の詳細は原文のまま。否定的な素材は削除禁止）
  ③ 構成プラン（コード）  ④ LLM 1回（各文に source_ids を付けた固定JSON）
  ⑤ 決定的な Linter（意味のガードを含む）
  ⑥ 危険ケースのみ、同期で意味を検証（NG・タイムアウトならその文を削除＝fail-closed）
  ⑦ 該当文の削除 or 1回だけ部分修正
  ──▶ 下書き（「内容を確認して、必要に応じて編集してください」）──▶ 本人が確認・編集 ──▶ CTA（全員に同じものを表示）
  └ after()：危険ケース以外は影の検証で計測 → ai_generation_events（本文は保存しない）

══════════ ここから別イベント（Googleで実際に起きたこと） ══════════

【気づく】 ※ G1 を通過してから
GBP ◀── OAuth（オーナーが手動でサインインして同意）
POST /api/cron/reviews/sync（cron-job.org・15分ごと）
  claim（SKIP LOCKED＋リーストークン）→ reviews.list（fetch）→ ingest RPC（upsert＋新着判定＋deliveries を1トランザクションで）→ complete
配信ワーカー → push（X-Line-Retry-Key）→ 口コミ通知専用のLINE公式アカウント
  文面：G2 の前は「新しいGoogle口コミが届きました／SalonPackで確認する」だけ
       G2 の後は★・本文の冒頭（G2 の結果の範囲内で）

【返信する】
G1 の後：一覧 → [Googleで返信する]（reviewReplyUrl）／[コピー]
G2 の後：一覧 → [AIで返信を作る] → 返信エンジン → [コピー]／（Phase 5）[Googleへ返信]（1件ずつ明示操作）
G1 の前でも：貼り付け型のAI返信（Phase 2。オーナーが入力した文章）
```

### 4-2 アップグレード時の接続維持（再連携ゼロ）
```
口コミ465（plan=reviews）              SalonPack（plan=salonpack）
口コミ通知LINE ── planの値だけ変更 ──▶ 同じ行をそのまま使う（再連携なし）
Google連携     ──（行は不変）───────▶ 同じ行・同じrefresh token
                                        予約通知LINE：初めて使うときだけ新規連携（既存の line_connections）
```
- 接続は salon_id に紐づく行で、plan に依存しない。新しい Feature キーは**両モード・両プラン**に含める。
- デプロイは1つなので（§0）、plan を変えてもドメイン・ログイン・環境変数は変わらない。GBP の OAuth redirect URI・`REVIEW_LINE_*`・暗号化鍵は、この1つのデプロイに設定すればよい（v3：v2 の「両方のVercelプロジェクトで同じ値にする」は不要になった）。
- LINE webhook は、このデプロイのドメインに1つ置く。
- 既存 hmail 利用者の予約通知LINE は、既存の移行計画で destination_id を引き継ぐ。本計画はその表に触れない。

### 4-3 既存システムとの分離
| 対象 | 方針 |
|---|---|
| hmail スキーマ・本番・cron | 一切触れない |
| 0009 のテーブル、`lib/notifications/**`、poll-mail | 変更しない。新機能からは読み書きしない |
| Google Cloud | GBP 用に**新しいプロジェクトとクライアント**（hmail の `createOAuthClient` / `classifyGoogleError` は流用しない） |
| LINE | 口コミ通知用の**新しい公式アカウント**（hmail と同じ provider を推奨。連携コードの接頭辞は `HP-` 以外にする） |
| cron | 新しいエンドポイント・シークレット・ログテーブル |
| OpenAI | 共通クライアントを切り出し、blog の挙動は変えない |

---

## 5. DB変更案（※まだ作成・適用しない）

**共通方針**
- **番号は作成した順に採番する**（Gate によって作る順番が変わるため、ここでは名前で示す）。すべて追加のみで、0009 と hmail は変更しない。
- 店舗ごとのテーブルは `salon_id uuid not null references salons(id) on delete cascade` を持つ。オーナーではなく**店舗にぶら下げる**ので、将来 1オーナー複数店舗や salon_members を導入しても変更不要。
- RLS は全テーブルで有効にする。
  - **秘密系**（トークン・LINE宛先・連携コード・配信・レート制限）：service role のみ。
  - **閲覧系**（口コミキャッシュ・返信下書き・イベント集計）：オーナーの SELECT ポリシー `is_salon_owner(salon_id)` を付けて多層防御にする（将来 salon_members が入っても、この関数の中身を変えるだけで済む）。書き込みは service role のみ。
- 新しいRPCは revoke / grant と `set search_path` をセットで指定する。

| 名前 | Phase / Gate | 内容 |
|---|---|---|
| `salons_plan_guard` | 0 | salons の BEFORE INSERT/UPDATE トリガー（下記）。**plan の改ざん防止が目的**。→ 0011 として本番に適用・検証済み |
| `create_salon_rpc`（任意） | 0 | advisory lock 付きで店舗を作成する RPC（同時作成による重複を防ぐ。「1店舗まで」のルールはアプリ側で持ち、DB制約にはしない）。→ 見送り（必要になったら再検討） |
| `ai_generation_events` | 1 | 生成イベント（feature: review_generation / reply_generation）＋ `rate_limit_buckets` ＋ `rate_limit_hit()` |
| `question_roles`（任意） | 1以降 | 質問の役割列。0004/0005/0007 にも通す必要があるため、効果が確認できてから入れる |
| `review_notifications` | 4（G1 の前に作ってよい） | 通知設定、受信者、連携コード、配信、関連RPC |
| `google_business_connections` / `google_business_locations` / `google_reviews` / `review_sync_runs` | 3（**G1 の後**） | 連携、ロケーション、口コミキャッシュ、同期ログ。ingest RPC |
| `review_reply_drafts` / `review_reply_settings` | Google 由来の口コミは **G2 の後** | 返信下書き（Phase 2 は保存しない） |
| `review_reply_posting` | 5（G1 で投稿の運用を確認したあと） | 投稿状態、二重投稿を防ぐ部分 unique、追記専用の監査ログ |

**salons_plan_guard の方針**
- `current_user` が anon / authenticated のときだけチェックする（service_role と postgres は素通し）。
- **INSERT**：`plan <> 'reviews'` なら拒否する。`createSalonAction` は 'reviews' を明示しているので影響しない。
- **UPDATE**：許可リスト `name, description, business_type, google_review_url, onboarding_completed, updated_at` 以外の列が変われば拒否する。plan のほかに owner_id・slug・将来追加する契約系の列も既定で保護される。許可リストは実際にクライアントが書いている列と一致させる。
- plan だけを対象にした最小版（plan の変更だけを拒否する）にもできる（§11-Q2）。
- **検証**：ロールバックするトランザクションの中で、authenticated として plan の変更が 42501 で拒否され、許可された列は更新できることを確認する。

**店舗コンテキストの解決（unique(owner_id) は使わない）**
- **`getCurrentSalon` を決定的にする**
  - ORDER BY は `created_at asc, id asc`。embedding の結果が配列でもオブジェクトでも受け付ける。
  - 複数の店舗が見つかったら警告をログに出す（現状の商品仕様では1店舗の想定なので、観測できるようにする）。
- **「1店舗まで」は商品のルールとしてアプリ側で持つ**
  - `createSalonAction` は既存の店舗を確認する。同時に作成されても重複しないよう、任意で `create_salon_rpc`（`pg_advisory_xact_lock(オーナー)` → 件数を確認 → 作成）を使う。
  - DB制約ではないので、将来は RPC のルールを変えるだけで複数店舗を許可できる。
- **将来の拡張**：`resolveSalonContext()` という入口に処理をまとめる。
  - 今はオーナーの唯一の店舗を返す。
  - 将来は選択中の店舗（`profiles.current_salon_id` または cookie）を salon_members の所属で検証して返す。
  - 呼び出し側（requireFeatureAccess 等）は変更不要にする。
- `owner_delete` ポリシーの見直しは別の論点。Google トークンを保存する前（Phase 3）に、店舗を削除するときの revoke の手順と合わせて決める。

### テーブル設計（主要な点）
- **ai_generation_events**
  - 主要カラム：generation_id, feature, kind（generated|regenerated|cta_clicked|failed|rate_limited）, prompt_version, model, latency_ms, tokens, lint_flags, verify_flags, verify_mode（none|sync|shadow）, repair_action。
  - `unique(generation_id, kind)`。**本文と回答は保存しない**。
- **google_business_connections**（秘密系）
  - 主要カラム：salon_id unique, google_sub, email, 暗号化した refresh token（AES-256-GCM・専用の鍵束・key_version・AAD に connection_id）, scopes, status, 失敗回数。
  - アクセストークンは保存しない。
- **google_business_locations**
  - 主要カラム：account_id, location_id, title, place_id, new_review_uri, notify_from, 同期状態（watermark・next_sync_at・リーストークン・last_full_refresh_at）。
  - 部分 unique：(salon_id) where active、(location_id) where active。
- **google_reviews**（閲覧系。**25日のキャッシュ**）
  - 主要カラム
    - 識別：review_key（`locations/{l}/reviews/{r}`。accounts/ の部分は含めない）, review_key_hash。
    - 内容：star_rating, comment, reviewer_display_name, is_anonymous, create_time, update_time。
    - 返信：reply_comment, reply_state, **review_reply_url**。
    - 観測情報：first_seen_at, last_fetched_at。
  - 25日を過ぎたら削除し、読み出しも last_fetched_at で絞る。1日1回、先頭ページを取り直す。集計はしない。
  - **reviewReplyUrl の扱い（推奨：キャッシュ＋押したときの補完）**
    - list のレスポンスに含まれるので、取得に追加のコストはかからない。→ 25日キャッシュに含める。
    - 「Googleで返信する」を押したら、サーバーで自店舗の口コミかを確認し、キャッシュが新しければそのURLを開く。キャッシュがない・期限切れなら `reviews.get` を1回呼んで取得する。
    - 毎回APIから取得する案は、クォータを消費し、押してから開くまでも遅くなるので採らない。
    - 注意：端末で、その店舗の権限を持つGoogleアカウントにログインしている必要がある。画面でその旨を案内する。
- **review_notification_recipients**（秘密系）
  - 主要カラム：channel_key, destination_type（user|group。今回は user のみ実装）, destination_id, label, status（active|blocked|removed。物理削除しない）。
  - `unique(salon_id, channel_key, destination_id)`。destination_id はクライアントに返さない。
- **review_line_link_codes**：code_hash unique（接頭辞は `KR-` など）、30分で失効、webhookEventId で重複受信を除く。コードの消費と受信者の登録は1つのRPCで行う。
- **review_notification_deliveries**（outbox）
  - 主要カラム：recipient_id, event_type（new_review|digest|test）, review_key_hash, status（pending|sending|sent|failed|expired|skipped|quota_blocked）, attempts, first_attempt_at, next_attempt_at, lease_until, line_retry_key（再送しても同じ値）。
  - 部分 unique：(recipient_id, 'new_review', review_key_hash)。
  - **本文は保存しない**。送信時に組み立て、G2 の前は最小の文面にする。
- **review_reply_drafts**（G2 の後）：google_review_id（set null）, review_key_hash, draft_text, edited_text, status, safety_mode。Google 由来の本文は複製しない。
- **将来機能の妨げにしない工夫**：channel_key（将来の店舗別LINE・CRM）、追加しやすい enum、お客様の個人情報を保存しない。

---

## 6. API / Server Action / Cron 設計

### 新規
| 種別 | 名前 | 認可・Gate | 内容 | Phase |
|---|---|---|---|---|
| Route | `POST /api/review-events` | 公開。generation_id と店舗を検証し、レート制限 | CTAのクリックを記録する | 1 |
| Action | `generateReplyAction` | `requireFeatureAccess('review_replies')`、レート制限 | Phase 2：貼り付け入力でステートレス。Google 由来の口コミ（google_review_id）は **G2 の後**（`GBP_CONTENT_TO_AI_ENABLED` で止める） | 2 / G2 |
| Route | `GET /api/google-business/oauth/start` / `callback` | `requireFeatureAccess('google_reviews')`、**G1 の後**（allowlist で公開） | nonce と PKCE は httpOnly cookie、state は署名付き・1回限り・セッションのユーザーと店舗に一致すること、scope の確認、redirect URI は APP_ORIGIN から作る、戻り先は相対パスのみ | 3 |
| Action | ロケーション選択・解除・「最新を取得」 | `google_reviews` | 解除時は、同じ google_sub の接続が他になければ revoke し、データを削除する | 3 |
| Action | `openReplyOnGoogleAction` | `google_reviews` | 自店舗の口コミかを確認 → キャッシュの reviewReplyUrl、なければ reviews.get で取得してURLを返す | 3 |
| Route | `POST /api/cron/reviews/sync` / `maintenance` | Bearer `REVIEWS_CRON_SECRET`（timingSafeEqual）＋ `REVIEWS_JOBS_ENABLED`、dryRun 対応 | 同期・ingest・配信／25日パージ等 | 3 / 4 |
| Route | `POST /api/line/review-notify/webhook` | 署名の検証（生のボディ） | 連携コード・follow・unfollow の処理 | 4 |
| Action | 受信者の管理・テスト送信 | `review_notifications` | テスト送信は「テスト通知です」の固定文面にする（Gate に関係しない） | 4 |
| Action | `postReplyToGoogleAction` | `google_reviews`。**G1 で「1件ずつの明示操作による投稿」が許可されたことを確認してから** | 確認ダイアログ → 口コミを取り直す → 上書きの確認 → updateReply → 監査ログ。**自動投稿はしない** | 5 |

### 変更
| 対象 | 変更内容 |
|---|---|
| `POST /api/generate-review` | §7-1 に置き換える（`REVIEW_PIPELINE=v1\|v2` で即時に戻せる。旧形式のリクエストも1リリースの間は受け付ける。maxDuration を設定し、本文をログに出さない） |
| お客様ページ（ReviewFlow / GeneratedReview） | 確認文言と CTA の文言（§8）。中立・否定の入力欄は作らない（v3）。CTA は回答によって出し分けないことをテストで保証する |
| seed.sql（テンプレート） | **変更しない**（v3：中立・否定の選択肢は追加しない） |
| `lib/appMode.ts` / `plan.ts` | `review_replies` / `google_reviews` / `review_notifications` を両モード・両プランに追加する（Phase 0 で完了） |
| `lib/supabase/queries.ts` / `dashboard/actions.ts` | 店舗コンテキストを決定的にする（§5。Phase 0 で完了） |
| `getAppMode` | **変更しない**（v3：1デプロイ構成では fail-open が正しい既定値。整理は別タスク） |
| `lib/ai/openai.ts`（新規） | 共通クライアント（タスクごとのモデル、usage、再試行、パラメータ互換）。blog は不変（Phase 0 で追加済み） |
| 変更しないもの | `lib/notifications/**`、0009、poll-mail、blog の生成、hmail |

### Cron / バックグラウンド処理（G1 の後に有効化）
| 論点 | 方針 |
|---|---|
| 頻度 | 15分（cron-job.org）。ジッタ、1回50ロケーション・並列3、45秒で打ち切り、1日1回は先頭ページを取り直す |
| 既存cronと分けるか | 分ける |
| 同時実行対策 | SKIP LOCKED ＋リーストークン。完了はトークンが一致したときだけ反映し、watermark は greatest にする |
| 失敗時の再実行 | watermark からの reconciliation、バックオフ、invalid_grant が2回続いたら needs_reconnect |
| at-most-once / at-least-once | **at-least-once ＋冪等キー**。ingest RPC で取り込みと通知の登録を1つのトランザクションにする |
| 配信の状態遷移 | 2xx/409 なら sent ／ 5xx なら24時間以内に再送 ／ 24時間を超えたら expired ／ 4xx なら skipped と blocked ／ 月間上限なら quota_blocked と警告 |
| 重複通知の防止 | 部分 unique、新着条件（notify_from 以降・7日以内）、retry key、accounts/ を除いたキー |
| 通数の管理 | 送信数カウンタ、3件以上はダイジェストにまとめる |
| plan確認 | DB の plan だけで判定する（`isFeatureServedByMode` は使わない） |

### セキュリティチェックリスト
- refresh token は AES-256-GCM＋AAD、専用の鍵束、service role のみ、`server-only`、ログに出さない。
- salon_id はクライアントから受け取らず、`resolveSalonContext()` で解決する。クライアントから来る ID はすべて自店舗かどうかDBで照合する。
- APP_MODE だけで判定せず、すべての入口で `requireFeatureAccess` を呼ぶ。plan はトリガーで保護する。cron は DB の plan と接続状態で判定する。
- 閲覧系は RLS とアプリの二重、秘密系は deny-all。他店舗のIDで拒否されることを結合テストで確認する。
- OAuth は1回限りの state、PKCE、セッションとの照合。Gate はフラグで強制する（`GOOGLE_REVIEWS_ALLOWLIST` / `GBP_CONTENT_TO_AI_ENABLED` / `GBP_CONTENT_IN_LINE_ENABLED` の既定値はすべて無効）。

---

## 7. AI生成設計

### 7-1 口コミ生成

**アンケートとCTA（Phase 1 の必須要件。v3 で改訂）**
- **中立・否定の選択肢は追加しない**（v3）。新しいテンプレート（seed.sql）にも既存店舗のアンケートにも足さず、システム側で常に表示する欄も作らない。
  - そのため、否定的な内容が入ってくるのは主に**自由記述**と**「その他」の詳細**。オーナーが自分で否定的な選択肢を作った場合は、その選択肢からも入る。
- **否定的な内容の扱い（必須ルール。コードの検査と意味検証で保証する）**
  1. **削除しない**：否定的な素材は「使わない素材」にできない（コードで保証する）。必ず1文以上に反映する。
  2. **ポジティブに反転しない**（例：「待ち時間が長かった」→「待ち時間も気にならなかった」は NG）。
  3. **不自然に弱めない**（例：「説明が分かりにくかった」→「説明は少しだけ分かりにくい気もしましたが、大満足です」のような打ち消し・矮小化は NG）。
  4. **事実は作らない。気持ちは補ってよい**（v3.1 で変更）：具体的な施術内容・効果・症状の改善・数値・期間・金額・スタッフの行動・設備やサービス・予約の状況・来店回数・他店との比較・紹介や再来店の事実は、回答に無ければ書かない。一方、回答と矛盾しない気持ち・主観的な反応（嬉しかった、よかった、気に入った、印象に残った、ありがたかった、相談しやすかった、居心地がよかった、丁寧だと感じた、またお願いしたいと思える など）は補ってよい。極端な感情（大感動、人生が変わった、絶対おすすめ、100%満足、過去一、絶対また行く）は使わない。
  - 削除するかどうかは本人が編集で決める（本人の口コミなので）。
- **review gating を絶対に行わない**
  - Google口コミへの導線は、回答の内容・満足度・評価にかかわらず**全員に同じように表示する**。
  - 不満のある人だけを別の窓口に誘導する機能も作らない。
  - CTA コンポーネントには条件で表示を切り替える引数を持たせず、否定的な回答でも CTA が表示されることを単体テストで保証する。
- **投稿前の本人確認**
  - 下書きの上に「**内容を確認して、必要に応じて編集してください。**」と表示する（2026-10-04 に文言を確定し、同日に短くした）。
  - CTA は「この内容をコピーしてGoogleへ進む」にし、その下に「自動で投稿されることはありません」と表示する。コピーされるのは編集後の文章。
  - 確認チェックボックスを付けるかは §11-Q6。

**生成パイプライン（Stage 1〜4 との対応）**
1. **素材の整理（コード）**
   - DB で照合する（ID→質問文→選択肢文。照合できなければ409）。
   - 素材 M1..M20 を作る：選択肢／「その他」の詳細／自由記述（原文）。
   - 役割は質問文のキーワードで判定する。
   - 極性は否定語の辞書で付ける。
2. **構成プラン（コード）**
   - 主役1〜2、補助0〜2、使わない素材（**否定的な素材は除外できない**）を決める。
   - 長さは短・中・長から選ぶ。
   - 書き出し・締めの型は素材に合うものだけから選ぶ。
3. **作文（LLM 1回）**
   - 固定の JSON Schema（`{sentences:[{text, source_ids(M1..M20), break_after}]}`）。
   - 固定のルールを先頭、素材を末尾に置く（キャッシュが効く）。
   - 例文は「素材 → 口コミ」のペアにする。
4. **決定的な Linter**：§7-1 の意味のガード、語尾の連続、要注意フレーズ、素材にない状況語、丁寧語のインフレ、自由記述の保持率、絵文字・★、業種外の語。v3.1 からは、事実の捏造（状況・数値・期間・金額・他店比較・来店回数）、効果の捏造、極端な感情、他者への呼びかけ、アンケートの要約だけ（robotic_survey_summary）・主観の無さ（low_emotional_texture）・文型の均一さ（uniform_sentence_structure）を判定する。
5. **意味の検証**：下記の比較による。
6. **修正**：NGの文を削っても主役が残るなら削除する。残らなければ1回だけ部分修正する。それでも駄目なら1回だけ再生成し、駄目ならエラーを返す。
   - ただし、削除で**否定的な素材の反映がなくなる**場合は削除で済ませない。部分修正を1回行い、それでも駄目なら、お客様本人の自由記述（「その他」の詳細）の原文を1文として残す（本人の言葉なので反転・誇張が起きない）。

**source_ids の限界**
- source_ids は「どの素材をもとに書いたか」の自己申告でしかなく、**意味が正しいことは保証しない**。
  - 例：素材「肌がなめらかに**感じた**」→ AI「肌荒れが**改善した**」。source_id は同じでも、内容は誇張されている（新しい概念「肌荒れ」と、変化を断定する「改善した」）。
- そこで、決定的な**意味のガード**を Linter に入れる（安く、誤検知が少ないもの）。
  - **新しい概念語**：出典の素材にも一般語のリストにもない内容語を警告する（例：肌荒れ）。
  - **変化・結果の動詞**：改善／治／消え／なくな／良くなっ／変わっ／効い／若返 などが、素材に根拠がないのに出てきたら NG。
  - **知覚表現の保持**：素材が「〜ように感じた／気がした」なら、文にも知覚表現が残っているか。
  - **極性の反転**：否定的な素材を出典とする文に、反転語（全く気にならなかった 等）がないか。
  - **弱め表現**（v3）：否定的な素材を出典とする文に、打ち消し・矮小化の語（少しだけ／気にならない程度／〜けど大満足 など）がないか。否定の中心となる語が残っているか。
  - ~~満足表現の追加~~（v3.1 で廃止）：満足・推奨などの気持ちは補ってよい。かわりに **極端な感情**（大感動／絶対／過去一 など）を指摘し、「最高」「感動」などの強めの語は意味検証で回答と比べる。
- ただし語彙リストの外にある言い換えは見逃す。→ 危険なケースは LLM で意味を検証する。

**意味の検証方式の比較**
| 方式 | 内容 | 待ち時間 | 意味の誇張を防げるか | 評価 |
|---|---|---|---|---|
| A. source_ids＋決定的 Linter のみ | 上の意味のガードまで | 増えない | 語彙の外の言い換えは見逃す | 単独では不十分 |
| B. A＋影の検証（after） | 非同期で検証し、記録するだけ | 増えない | 防げない（計測のみ） | 計測用に併用する |
| **C. A＋危険ケースのみ同期で検証【推奨】** | 危険トリガー（効果・変化・医療の語、比較・強調、否定的な素材、Linter の警告）に当たったときだけ、日本語に強いモデルで文ごとに検証する（主張の強さが素材を超えていないか／反転していないか／不自然に弱めていないか／事実・効果を作っていないか／極端な感情がないか）。v3.1 からは、回答と矛盾しない自然な気持ちは問題にしない。**NG・タイムアウトならその文を削除（fail-closed）** | 該当したときだけ1〜2秒増える（該当率はオフライン評価で計測） | 危険な領域は防げる | ◎ |
| D. 毎回同期で検証 | 全リクエストで検証する | p95で2〜4秒増える | 最も広い | C で見逃しが多い場合に移行する |
- C では、危険ケースに当たらなかったリクエストも B（影の検証）で計測し、見逃し率を監視する。
- 検証用のモデルは日本語のニュアンスを判定できるものにする（nano 級は使わない）。推論系モデルは同期処理では使わない。

**その他**
- **自由記述の優先**：主役候補の1位にする。語彙をなるべくそのまま使わせ、丁寧語への言い換えを禁止する。個人名・電話番号は伏せる。
- **再生成**：前回のプランの enum を受け取り、別の組み合わせを選ぶ（署名は不要。乱用はレート制限で止める）。編集済みのときは置き換えの確認を出す。
- **乱用対策**：店舗の存在を確認する。`rate_limit_hit()` で IP＋店舗（店内Wi-Fiを考えて緩め）と、店舗ごとの1日の上限をかける。
- **品質の評価**
  - オフライン評価（30〜50件。**自由記述・「その他」に否定的な内容を含むケースを必須にする**）で v1 と v2 を比較する。
  - 指標：Linter の違反、意味検証のNG率・該当率、否定的な素材の反映率（100%が条件）、反転・不自然な弱め・事実/効果の捏造・極端な感情の件数（0件が条件）、気持ち・温度感と自然さの採点（v3.1）、文字数・語尾の分布、待ち時間。
- **コストの目安**：お客様が待つ間のLLM呼び出しは1回（危険ケースは＋検証1回、修正時はさらに＋1回）。gpt-4o-mini 換算で1回あたり約0.15〜0.25円。実際のモデルはオフライン評価で選ぶ。

### 7-2 口コミ返信生成（Phase 2 は貼り付け入力。Google 由来の口コミは G2 の後）
- **入力**：口コミ本文、★、店舗名、業種、店舗の特徴、返信設定（口調・絵文字・署名）、採用済みの過去の返信（Phase 3 以降、自社データ）。**投稿者の名前は既定で使わない**。
- **分類（コード）**：★1〜2・否定語は慎重モード、★3 は混合、★4〜5 は通常、評価だけなら短いお礼。
- **生成 LLM 1回**：`{respond_to:[口コミ中の具体的な箇所の引用], reply}`。口コミの具体的な内容への反応を構造で強制する。
- **Linter（共通エンジン）**：冒頭の定型句の繰り返し（variety.ts 方式）、反論、約束・補償、過剰な謝罪、口コミにないお客様情報、効果の断定、4096 bytes。
- **慎重モード**：共感とお礼を伝える。確認できない事実を認めず、否定もしない。反論も補償の約束もしない。連絡方法は店舗が設定している場合だけ案内し、短めに書く。「投稿前に内容をご確認ください」と表示する。
- **再生成・保存**
  - 再生成は、反応する箇所・書き出し・締めをコードで変える（1口コミにつき1日10回まで）。
  - Phase 2 はステートレスで、イベントだけ記録する。
  - G2 の後は `review_reply_drafts` に保存する（本文はキャッシュを参照する）。
- **文体の学習**：採用された返信（自社データ）を few-shot に使う。10件以上たまったら Style Profile 方式で文体を構造化する。Google の過去の返信を取り込む案は、保存・加工の制限があるので G2 で合わせて確認する。
- **Googleへの投稿（Phase 5）**：1件ずつ明示的に操作する。確認ダイアログで投稿する文面を見せ、投稿の直前に口コミを取り直す。審査状態を表示する。自動投稿はしない。

### 7-3 Humanizer の共通化（`lib/ai/naturalJapanese/`）
- `phrases.ts`（書き手ごとの辞書）、`analyze.ts`（文・語尾・知覚表現・極性・概念語）、`lint.ts`（意味のガードを含む）、`repairPrompt.ts`（該当する文だけを直す）。
- 口コミと返信で共通にする。blog は今回は触らない。

---

## 8. UI / UX案

**管理画面の構成（ナビ項目は増やさず、口コミの中にサブナビを置く）**
```
口コミ
├ 届いた口コミ   /dashboard/reviews/google        ← G1 の後に本機能。それまでは連携の説明と貼り付け型AI返信
├ 口コミを集める /dashboard/reviews               ← 既存（お客様用URL・質問）
└ LINE通知       /dashboard/reviews/notifications
設定 ＋「Google連携」（接続中のアカウント・店舗名・解除）
```

**お客様ページ（Phase 1）**
```
[質問] スタッフ・お店について感じたこと
  (スタッフが話しやすい) (落ち着いた雰囲気) … (その他 → 詳細欄)   ← 選択肢は今のまま（v3）
[自由記述] 今のテンプレートのまま
[ AIで口コミを作成する ]
──────────────────────────
口コミの下書きができました
内容を確認して、必要に応じて編集してください。
[下書き（編集可）]
[ この内容をコピーしてGoogleへ進む ]   ← 回答によらず全員に表示
自動で投稿されることはありません
```

**届いた口コミ（G1 の後・G2 の前）**
```
Google上の評価 ★4.6（128件）            ← APIの値をそのまま表示
[すべて] [未返信] [★1〜2]
┌──────────────────────┐
│★★★★★ 山田さん・2日前   未返信 │
│「初めて伺いましたが…」           │
│ [Googleで返信する] [本文をコピー] │   ← G2 の後に [AIで返信を作る] を追加
└──────────────────────┘
[もっと見る]（それより古い口コミはGoogleから直接表示）
未連携のとき：「Googleと連携すると…」[Googleと連携する]（G1 の後に表示）
            ＋「口コミを貼り付けて返信を作る」（Phase 2）
```

**LINE通知**
```
新着口コミをLINEでお知らせ   ● 通知中 [切替]
受け取る人：オーナー（10/3）[外す]／スタッフA（10/5）[外す]
[＋ 受け取る人を追加] → ①友だち追加 ②コードを送信 → 自動で完了
[テスト通知を送る]
（SalonPackのみ）予約通知とは別のLINEアカウントからお届けします
```

**通知の文面**
- **G2 の前**
  ```
  新しいGoogle口コミが届きました
  SalonPackで確認する ▶ …
  ```
  （v3：サービス名はブランドの決定に合わせて SalonPack にする。Phase 4 で最終確認）
- **G2 の後**：確認できた範囲で★と本文の冒頭を載せる。低評価用の文面（「内容をご確認ください」）を使う。

**方針**
- 専門用語は出さない。設定は「オン/オフ」と「受け取る人」だけにする。1画面の目的は1つにする。
- 連携のあとで、newReviewUri による口コミURLの自動入力を提案する。
- 「Googleで返信する」の近くに、「その店舗を管理しているGoogleアカウントでログインしている必要があります」と小さく案内する。

---

## 9. 実装フェーズとGate

**ブランチの進め方**
- `feature/reviews-465-v2` はすでに master へマージ済みなので、**再利用しない**。
- 実装を始めるときに、**最新の master からフェーズごとに新しいブランチ**を切る。
  - Phase 0：`feature/k465-phase0-foundation`（master に取り込み済み）。
  - Phase 1：`feature/k465-phase1-review-generation`（最新の master から作成済み。本書もこのブランチに置く）。

| Phase / Gate | 内容 | 依存 | 完了条件 |
|---|---|---|---|
| **0 安全の土台**（**完了**） | `salons_plan_guard`、店舗コンテキストの決定化（unique は使わない）、`lib/ai/openai.ts`、vitest、新しい Feature キー、server-only（blog のみ）、ブランドは常に SalonPack。`create_salon_rpc` と APP_MODE の fail-closed 化は行わない（v3） | なし | authenticated で plan を変えられない（0011 を本番で検証済み）。既存の設定・オンボーディング・blog が従来どおり動く |
| **1 口コミ生成**（詳細は §13） | v2 パイプライン（危険ケースの同期検証つき）、否定的な内容の保持（削除・反転・不自然な弱めの禁止）、事実・効果の捏造と極端な感情の禁止（v3.1）、確認の文言とCTA、gating 禁止のテスト、イベント、レート制限、オフライン評価 | 0 | Linter の重大違反0、否定的な素材の反映率100%、反転・弱め・事実/効果の捏造が0件、意味検証で誇張の見逃しがないこと（評価セット）、p95が v1 の+2秒以内 |
| **2 貼り付け型AI返信** | 返信エンジン（保存なし） | 0, 1 | 評価セットで反論・約束・過剰謝罪が0件 |
| 運営者の作業（すぐ始める） | GCPプロジェクト、API利用申請（**§3-2 のユースケースを記載**）、同意画面（プライバシーポリシー・利用規約）、新しいLINE公式アカウント | — | G1 / G2 の回答を記録する |
| **G1** | Google から「マルチテナントSaaSとしてこの運用でよい」ことの確認と、API承認（300 QPM） | 申請 | 書面の記録 |
| **3 Google連携・一覧** | OAuth、ロケーション、同期（通知なし）、パージ、一覧、reviewReplyUrl のボタン（allowlist の店舗から） | G1 | 同期を同時に2本走らせても結果が1つ、パージが働く、他店舗のIDで拒否される |
| **4 LINE通知** | 連携・受信者・配信の基盤（G1 の前に作り始めてよい）。新着の通知は Phase 3 の後に、**最小の文面で**有効化する | 3（新着の通知）、新OA | 重複しない（409→sent）、blocked、quota_blocked |
| **G2** | 本文を OpenAI に送ること・LINE に抜粋を載せることの確認 | 申請 | 書面の記録 |
| G2 の後の拡張 | 一覧から AI返信、LINE の★・本文の冒頭、低評価用の文面、返信下書きの保存 | G2 | — |
| **5 Googleへ直接返信** | 1件ずつの明示操作、確認ダイアログ、審査状態、監査ログ | G1（投稿の運用の確認）、3 | テスト店舗で反映まで確認できる |
| 6 以降 | Pub/Sub、グループLINE、返信の文体プロファイル、メール、CRM | — | 対象外 |

---

## 10. リスク一覧
| 領域 | リスク | 対策 |
|---|---|---|
| Google API（運用の許可） | **マルチテナントSaaSとしての運用が許可されない**、または各サロンが自分のプロジェクトを持つよう求められる | G1 を Phase 3 の開始条件にし、ユースケースを具体的に申請する。否定的な場合は貼り付け型と「Googleで返信する」の範囲にとどめる |
| Google API（データ） | 本文の OpenAI 送信や LINE 抜粋が許可されない | G2 の前は最小の文面にし、AI返信の導線を出さない |
| Google API | 承認が遅れる／300 QPM／30日保存／返信の審査／Pub/Sub の衝突／v4 の SDK がない | 早めに申請する、分散スケジュール、25日パージ、状態の表示、ポーリングを主にする、fetch で直接呼ぶ |
| OAuth | 同意画面が Testing のままで7日失効／hmail と共用／state の使い回し／revoke で他の連携も切れる | 本番公開、別プロジェクト、1回限りの state＋PKCE＋セッション照合、google_sub を確認してから revoke |
| アンケート | 肯定的な選択肢だけで、良い面だけの口コミになりやすい（選択肢は追加しない方針・v3） | 自由記述・「その他」の否定的な内容を必ず保持する（削除・反転・不自然な弱めを、検査と意味検証で禁止）、全員に同じ導線、投稿前の本人確認 |
| review gating | 将来の機能追加で CTA を出し分けてしまう | 禁止を明文化し、CTA が出し分けられない構造にしてテストで保証する |
| LLM | source_ids が同じでも意味を誇張する | 意味のガード＋危険ケースの同期検証（fail-closed）＋影の計測 |
| LLM | 返信での反論・補償の約束／モデル変更で blog が壊れる | 慎重モードと Linter、人が確認してから投稿、タスクごとのモデル設定 |
| LINE | 月間の通数を全店舗で共有／ブロック／webhook は1URL／hmail のチャネルとの干渉 | カウンタ・ダイジェスト・quota_blocked、unfollow で blocked、安定したドメイン、**別の公式アカウント** |
| cron | 抜け・二重起動・期限切れワーカーの上書き | SKIP LOCKED＋リーストークン、greatest、reconciliation |
| 重複通知 | 取り込み後に落ちる／パージ後の再取得／初回連携 | ingest RPC で1トランザクション、新着条件、notify_from |
| 既存hmail | 本番DBを共有 | hmail・0009・poll-mail・移行スクリプトに触れない |
| plan | plan の改ざん | Phase 0 のトリガー（0011。本番に適用・検証済み） |
| 店舗コンテキスト | 複数店舗のときに不定になる／将来の拡張を妨げる | 決定的な解決＋アプリ側のルール＋入口の関数。DB制約は入れない |
| アップグレード | （v3：デプロイが1つなので、ドメイン・ログイン・お客様URLは変わらない） | plan の値を変えるだけ |
| APP_MODE | Vercel で `NEXT_PUBLIC_APP_MODE=reviews` を設定すると、全店舗でブログ・予約通知が止まる | 設定しない（§0）。整理は別タスク |
| RLS | service role で条件を付け忘れる | リポジトリ関数、RLS の併用、結合テスト |
| 法務・ポリシー | AIで下書きした口コミ（偽エンゲージメント・ステマ規制） | 事実を足さない、gating しない、見返りと結びつけない、本人の確認・編集。**要法務確認** |
| 運用 | Vercel Hobby は商用不可 | **Pro が必要**（同期の頻度とは無関係） |

---

## 11. 実装前に確認したい事項
**Phase 0〜1 の前に**
1. **サービス名**：画面の「口コミ365」を「口コミ465」に変えてよいですか（「口コミ365」は他社名ですか）。→ **解決**：画面は常に「SalonPack」（v3）。
2. **plan 改ざん防止のトリガー**は、(a) 許可リスト方式（plan・owner_id・slug・将来の列も保護）【推奨】と、(b) plan だけを対象にする方式のどちらにしますか。同時作成を防ぐ `create_salon_rpc` も入れますか（任意）。→ **解決**：(a) で実施（0011）。`create_salon_rpc` は見送り。
3. **口コミ生成で何を保存するか**：(a) 何も保存しない／(b) **メタデータだけ保存する【推奨】**／(c) 本文も一定期間保存する（ポリシーの更新が必要）→ Phase 1 の前に回答が必要（§13-6）。
4. **意味の検証方式**：**C（危険ケースのみ同期で検証し、ほかは影の検証で計測）【推奨】**／D（毎回同期で検証）→ Phase 1 の前に回答が必要（§13-6）。
5. **既存店舗への中立・否定の導入方法**：(a) **システム側で常に「気になった点（任意）」欄を表示し、新しいテンプレートに「特になし」「気になった点」を追加する【推奨】**／(b) 既存店舗のアンケートにも自動で追加する／(c) オーナーにワンクリックでの追加を促す → **解決**：中立・否定の選択肢は追加しない（v3）。
6. **投稿前の本人確認**：確認の文言と CTA の文言変更だけにする【推奨】か、「内容を確認しました」のチェックボックスも付けるか。→ Phase 1 の前に回答が必要（§13-6）。

**Phase 2〜3 の前に（G1 / G2）**
7. **API利用申請**：申請条件（60日以上認証済みで有効なGBP、Webサイト、オーナーまたは管理者のメール）を満たすGBPをお持ちですか。申請者は誰ですか。§3-2 のユースケースの文面で申請してよいですか。
8. **GBP 用の新しいGCPプロジェクト**【推奨】でよいですか。プライバシーポリシー・利用規約のURLはありますか。
9. **貼り付け型のAI返信（Phase 2、保存なし）**を先に出しますか【推奨】。

**Phase 4〜5 の前に**
10. **口コミ通知用の新しいLINE公式アカウント**：誰が作りますか。hmail と同じ provider でよいですか【推奨】。料金プランはどうしますか（全店舗分の通数は運営側の負担になります）。
11. **同期の頻度**：15分【推奨】／30分／5分
12. **Vercel Pro への移行**：商用提供のために必要です。時期はいつにしますか。
13. **Googleへの直接返信（Phase 5）**をロードマップに含めますか。

**将来に関わること**
14. **クーポン・抽選**を口コミ投稿の見返りにすると Google のポリシー違反になります。口コミとは切り離して設計する前提でよいですか。
15. **hmail の移行（カットオーバー）**：本計画とは独立して進められます。ただし SalonPack で予約通知のLINEを連携・再接続する手段は、そちらの計画で用意が必要です。

---

## 12. 実装の3分類
### A. 今すぐ実装できるもの（外部の承認・アカウントが不要。§11 の回答だけで着手できる）
- **Phase 0**（**完了**）：plan 改ざん防止のトリガー（0011。本番に適用・検証済み）、店舗コンテキストの決定化（unique は使わない）、共通OpenAIクライアント、vitest、新しい Feature キー、server-only（blog のみ）、ブランドは常に SalonPack。create_salon_rpc と APP_MODE の fail-closed 化は行わない（v3）。
- **Phase 1**（§13）：口コミ生成 v2（意味のガード、危険ケースの同期検証、修正、再生成）、否定的な内容の保持（削除・反転・不自然な弱めの禁止）、事実・効果の捏造と極端な感情の禁止（v3.1）、**review gating 禁止のテスト**、投稿前確認の UX、ai_generation_events、レート制限、オフライン評価スクリプト。中立・否定の選択肢は追加しない（v3）。
- **Phase 2**：貼り付け型のAI返信（オーナーが入力した文章のみ。保存なし）、返信用の Linter、評価セット。
- 共通：`lib/ai/naturalJapanese/`（Linter と意味のガード）、cron の認証ヘルパー。

### B. Google承認前でも実装できるもの（Google API を使わない。ただし LINE公式アカウントなど別の外部準備が必要で、本番公開はフラグで止める）
- **口コミ通知のLINE基盤**：新しい公式アカウント（運営者の作業）、webhook（署名の検証）、連携コード、受信者の管理画面、テスト通知（固定の文面）、配信の outbox・retry key・quota の処理。新着口コミのデータは使わず、テストデータで検証する。
- 「届いた口コミ」ページの外枠（未連携の状態の表示）、サブナビ。
- 同期・ingest・配信のロジックの**単体テスト**（モックのAPIレスポンス。本番の Google API は呼ばない）。
- 運営者の作業：GCPプロジェクトの作成、同意画面の準備、**API利用申請（§3-2 のユースケースを記載）**、Vercel Pro への移行。

### C. Google の承認・確認が取れるまで実装してはいけないもの
| Gate | 実装・有効化しないもの |
|---|---|
| **G1**（SaaS運用の確認とAPI承認） | 実際のサロンでの OAuth 接続、アカウント/ロケーションの取得、定期同期、口コミデータの保存（connections / locations / google_reviews の migration 適用を含む）、新着口コミの LINE 通知、reviewReplyUrl のボタン |
| **G2**（本文の外部送信の確認） | 取得した口コミ本文を OpenAI に送る AI返信（一覧の「AIで返信を作る」）、LINE 通知への本文・投稿者名・★の掲載、低評価の強調文面、Google の過去返信からの文体学習 |
| **G1（投稿の運用確認）＋確認ダイアログの設計レビュー** | Googleへの直接返信（updateReply）、返信の削除 |
| 対象外（ポリシー上、当面は行わない） | 自動返信、Pub/Sub による他ツール設定の上書き、口コミデータの集計・分析、口コミと見返り（クーポン・抽選）の結びつけ |

---

## 検証方法（実装時）
- **全フェーズ共通**：lint・build・vitest を通す。`git diff --stat` で `lib/notifications/**`・0009・hmail に変更がないことを確認する。cron は dryRun で事前に確認する。Gate のフラグの既定値が無効であることをテストする。
- **Phase 0**：ロールバックするトランザクションの中で、authenticated として plan の変更・指定が 42501 で拒否されることと、許可された列は更新できることを確認する。店舗が複数ある場合のテストデータで、`getCurrentSalon` が決定的に1つを返すことを確認する。
- **Phase 1**
  - オフライン評価（自由記述・「その他」に否定的な内容を含むケースを必須にする）で v1 と v2 を比較し、オーナーに30件を目視で確認してもらう。
  - 否定的な回答でも CTA が表示されることを単体テストで確認する。
  - 本番は events で失敗率・p95・同期検証の該当率と NG 率を監視する。問題があれば `REVIEW_PIPELINE=v1` に戻す。
- **Phase 2**：返信の評価セットで、禁止表現が0件であることと、具体的な箇所に反応していることを確認する。
- **Phase 3（G1 の後）**：テスト用のGBPで連携から一覧まで確認する。state の使い回しが拒否されること、同期を同時に2本実行しても結果が1つになること、パージ、reviewReplyUrl の補完、他店舗のIDでの拒否をテストする。
- **Phase 4**：不正な署名の拒否、連携コード（iOS / Android / PC）、二重配信のテスト（送信直後に強制終了 → 再実行で 409 → sent）、unfollow、quota_blocked、**G2 の前の文面に本文・名前・★が含まれないこと**を確認する。
- **Phase 5**：テスト用の店舗で投稿から審査状態の反映まで確認し、監査ログと二重投稿の防止を確かめる。

---

## 13. Phase 1 実装計画（v3 で追加）

### 13-1 目的と完了条件
- **目的**：お客様の回答から、AIっぽくなく、事実を足さず、誇張せず、否定的な内容を消さない下書きを作る。中立・否定の選択肢は追加しない（v3）。
- **必須ルール**（コードの検査・意味検証・テストで保証する）
  1. 自由記述・「その他」に出た否定的な内容を**削除しない**
  2. ポジティブに**反転しない**
  3. **不自然に弱めない**
  4. **事実は作らない**（v3.1。気持ち・温度感は回答と矛盾しない範囲で補ってよい。極端な感情は使わない）
  5. **review gating をしない**（回答で導線を変えない）
  6. **全員に同じGoogle口コミの導線**を出す
- **完了条件**（オフライン評価セットと単体テストで判定）
  - Linter の重大違反 0件
  - 否定的な素材の反映率 100%。反転・不自然な弱め・事実/効果の捏造 0件
  - アンケートの要約のような下書きにしない（読み手としての採点で、気持ち・温度感と自然さが v1 を上回る。v3.1）
  - 意味検証で誇張の見逃しがない
  - p95 が v1 の +2秒以内
  - 否定的な回答でも CTA が表示される（単体テスト）
  - オーナーが30件を目視し、v1 より自然だと判断できる

### 13-2 処理の流れ
```
お客様ページ（ReviewFlow）
  └ POST /api/generate-review
      { salonId, answers: [{ questionId, values, otherDetail? }], regenerate?: { previousPlan } }
      ① 照合：salon_public → 有効なアンケート → 質問・選択肢（anon で読める範囲）。
         ID で照合し、見つからなければ質問文で照合する。選択肢にない値は「その他」の詳細を除いて受け付けない
         （409。ページの再読み込みを案内する）。質問文・前回の文章をクライアントから受け取らない
      ② レート制限（IP＋店舗、店舗ごとの1日の上限）。IP はハッシュにしてから使い、そのままは保存しない
      ③ 素材シート（コード）：選択肢／「その他」の詳細／自由記述（原文。電話番号・メールアドレスは伏せる）。
         役割（来店回数・来店理由・体感・スタッフ/店内・自由記述）と極性（否定語の辞書）を付ける
      ④ 構成プラン（コード）：主役1〜2・補助0〜2・長さ・書き出し/締めの型。否定的な素材は必ず使う
      ⑤ 作文（LLM 1回。json_schema strict）：{ sentences: [{ text, source_ids, break_after }] }
      ⑥ Linter（コード）＋意味のガード（§7-1。v3.1 の判定: 事実・効果の捏造、極端な感情、否定の反転・弱め、要約だけ・主観の無さ・文型の均一さ）
      ⑦ 危険ケースだけ同期で意味検証（NG・タイムアウトはその文を削除＝fail-closed）
      ⑧ 修正：削除で足りなければ1回だけ部分修正。否定的な素材の反映が消える場合は、本人の原文を1文として残す
      ⑨ 下書き全体が事実の列挙だけ・アンケートの要約だけなら、事実を足さずに1回だけ書き直す（v3.1）
  └ レスポンス { draft, generationId, plan }
      → 下書き・確認文言・CTA を表示（CTA は全員に同じ。回答による出し分けの引数を持たない）
  └ after()：危険ケース以外は一部を影で検証し、ai_generation_events に記録（回答・本文は保存しない）
```

### 13-3 作業の分割（commit 単位。この順に進める）
| # | 内容 | 主なファイル | 本番への影響 |
|---|---|---|---|
| 1 | 日本語チェックの共通部品：文・語尾・知覚表現・極性・概念語の解析と、Linter（意味のガード、弱め表現、事実の捏造・効果の捏造・極端な感情（v3.1）、定型句、素材にない状況語、絵文字） | `lib/ai/naturalJapanese/{phrases,analyze,lint}.ts` | なし（まだどこからも使わない） |
| 2 | 素材シートと構成プラン | `lib/reviewGeneration/{materials,plan}.ts` | なし |
| 3 | 作文・意味検証・修正の組み立てとプロンプト（`lib/ai/openai.ts` を使う） | `lib/reviewGeneration/{pipeline,prompts,verify,repair}.ts` | なし |
| 4 | API：回答のDB照合、`REVIEW_PIPELINE=v1\|v2`（既定 v1）による切り替え、旧形式のリクエストも1リリースの間は受け付ける、回答・生成した文章をログに出さない | `app/api/generate-review/route.ts`、`lib/reviewGeneration/validateAnswers.ts` | 既定は v1 なので生成結果は変わらない。照合とログの変更は v1 でも効く |
| 5 | お客様ページ：新しいリクエスト形式、確認文言、CTA「この内容をコピーしてGoogleへ進む」、再生成で前回のプランを送る | `components/review/{ReviewFlow,GeneratedReview}.tsx` | 文言が変わる（v1 のままでも） |
| 6 | DB：`ai_generation_events`、`rate_limit_buckets`、`rate_limit_hit()`（RLS 有効・service role のみ）と、CTA クリックの記録 `POST /api/review-events` | `supabase/migrations/0012_review_generation_events.sql`、`app/api/review-events/route.ts`、手順書 | migration は **master に入れてから**手動で適用する（§13-5） |
| 7 | オフライン評価：評価セット30〜50件（自由記述・「その他」に否定的な内容を含むケースを必須にする。架空の回答だけを使う）と、v1/v2 の比較スクリプト | `scripts/eval-review-generation.ts`、`__tests__/fixtures/review-cases/` | なし |

- 変更しないもの：seed.sql（選択肢は追加しない）、`lib/appMode.ts`、`lib/notifications/**`、blog、hmail。
- イベント記録・レート制限で DB のエラーが起きたときは、お客様の生成を止めずに通し、ログに残す（0012 を適用する前の期間も、この動きになる）。

### 13-4 テスト（vitest。外部 API は呼ばない）
- **素材**：役割の判定、極性（否定語の辞書）、ID→質問文の照合、選択肢にない値の拒否、電話番号・メールアドレスの伏せ字。
- **構成プラン**：否定的な素材が必ず使われる、再生成で前回と違う組み合わせになる（乱数は外から渡して固定する）。
- **Linter**：ルールごとに OK と NG の例（反転、弱め、事実・効果の捏造、極端な感情、要約だけ・主観の無さ、変化の断定、知覚表現の消失、素材にない状況語、定型句、語尾の連続、絵文字）。
- **パイプライン**（OpenAI はモック）：意味検証が NG かタイムアウトならその文が消える。否定的な素材の反映が消えるときは原文が残る。修正は1回まで。失敗したらエラーを返す。
- **API**：不正な形式は400、照合できなければ409、レート制限は429、旧形式も受け付ける、`REVIEW_PIPELINE` で切り替わる、ログに回答や本文が出ない。
- **CTA**：否定的な回答のケースでも CTA が表示される（`react-dom/server` で描画して確認する。新しい依存は足さない）。

### 13-5 リリース手順（DB を master より先に変えない）
1. Phase 1 を master に merge し、本番にデプロイする。`REVIEW_PIPELINE` は未設定（＝v1）のままにする。この時点で効くのは、文言の変更・回答の照合・ログの変更だけ。
2. 0012 を本番 Supabase に手動で適用し、手順書の確認SQLで確かめる。
3. オフライン評価の結果とオーナーの目視確認を見て、Vercel の環境変数 `REVIEW_PIPELINE=v2` を設定し、再デプロイする。
4. `ai_generation_events` で、失敗率・p95・同期検証の該当率と NG 率を見る。問題があれば `REVIEW_PIPELINE=v1` に戻して再デプロイする。

### 13-6 着手前に決めていただきたいこと
1. **生成で何を保存するか**（§11-Q3）：**メタデータだけ【推奨】**（回答と本文は保存しない）／何も保存しない／本文も一定期間保存する
2. **意味検証の方式**（§11-Q4）：**C：危険ケースだけ同期で検証し、ほかは影で計測【推奨】**／D：毎回同期で検証
3. **投稿前の本人確認**（§11-Q6）：**確認文言と CTA の文言だけ【推奨】**／「内容を確認しました」のチェックボックスも付ける
4. **切り替え方**：**`REVIEW_PIPELINE` で v1/v2 を切り替え、評価と目視確認のあとで v2 にする【推奨】**
5. **オフライン評価の実行**：OpenAI の API を使う。費用は mini 級のモデルなら1回の評価で数十円程度の見込み（モデルによって変わる）。評価セットは架空の回答だけで、実在のお客様のデータは使わない。ローカルの `.env.local` のキーで実行してよいか
6. **レート制限の初期値**：IP＋店舗で10分に10回、店舗ごとに1日300回【案】（環境変数で変えられるようにする）
7. **使うモデル**：作文は今の `OPENAI_MODEL`。意味検証は、日本語のニュアンスを判断できる推論系以外のモデル。具体的なモデルは評価で決める

## 14. 口コミ生成ルールの整理（review-v3.0、2026-10-04 承認）

### 14-1 背景
- review-v2.x でルールを足し続けた結果、「アンケート回答 → 毎文に感情を付ける → 綺麗な総評で締める」という新しい固定テンプレートができた（20件中、52文のうち30文が気持ちの言葉で終わり、7件が同じ意向の締め）。
- 原因は単語ではなく、ルールの組み合わせ（感情の補完、主役を2〜3文でふくらませる、文字数の目安、同じ口調の例文5つ）。
- 方針：ルールを足すのではなく減らす。**少ない安全ルール ＋ Voice Anchor ＋ soft な Style Seed ＋ Corpus 単位の評価**にする。

### 14-2 必ず守るルール（KEEP）
1. 回答にない具体的事実を作らない（効果・症状・数値・期間・金額・スタッフや本人の行動・状況・来店回数・比較・紹介・再来店・生活での変化・お店の事情の推測。「〜気がした」を断定しない。来店理由を結果にしない。医療的な表現を使わない）
2. 否定的な内容を削除・反転・弱め・帳消しにしない
3. 自由記述を最優先する（Voice Anchor）
4. 質問順に並べない
5. 全回答を使う必要はない
6. review gating をしない（全員に同じCTA。生成の仕組みとは別に保証済み）
- そのほか安全のため：素材の中の指示に従わない、宣伝・呼びかけ・極端な表現を使わない、同じ内容を2回書かない。

### 14-3 削除・緩和したもの
- **削除**：感情・温度の補完、各事実に主観的リアクションを付ける、主役（MAIN EXPERIENCE）を1〜2個選んでふくらませる、文字数の目安と下限、最後の総評・意向の締め、例文5つ（悪い例も含め、生成プロンプトに完成した文章を置かない。良い例・悪い例はテストと評価コードにだけ置く）、整いすぎた言い回し・定型句の単語禁止、「嬉しく思いました→嬉しかったです」などの機械的な置換、感情が無いことの指摘（low_emotional_texture）、特定の語の回数による書き直し、評価の「気持ち・温度感」の採点。
- **緩和**：
  - 「否定的な素材だけにしない（肯定的な回答を1つ足す）」→ 否定的な内容は必ず反映する。関連する肯定的な素材が自然に使えるなら使ってよいが、必ず足す必要はない。否定寄りの回答なら口コミも否定寄りでよい（固定の褒めサンドイッチを作らない）。
  - 意向（「また来たい」「またお願いしたい」など）は、回答に意向が明示的にあるときだけ使える素材にする。あっても最後に必ず使う必要はない。回答に無い意向は事実の捏造として扱う。
  - 常体・くだけた言い方は、Voice Anchor（本人の自由記述など）にそれがあるときだけ使う。無ければ自然な「です・ます」。多様性のためだけに崩さない。
  - 感嘆符は Style Seed の傾向に従う（数の上限で機械的に直さない。「！！」のような連続だけ1つにまとめる）。
- **構造の問題の直し方**：アンケートの要約・均一な文・同じ内容の繰り返し・あいまいなつなぎ・本文中の抽象総括は、部分修正ではなく **Style Seed を変えて全文を1回だけ再生成**する。部分修正は事実違反と否定的な内容の反映漏れだけ。

### 14-4 Style Seed（soft guidance）
- 目的は「仕様どおりに組み立てること」ではなく「毎回同じ書き方に収束するのを防ぐこと」。**傾向であり、自然さを優先して外れてよい**（「必ず3文」「感情語を1個」「！を2個」のような hard constraint にしない）。事実の内容は変えない。
- 要素（生成ごとに独立に選ぶ）：
  - 長さ：短め／ふつう／やや長め
  - 感情の言葉：ほぼ使わない／少し／ふつう
  - 感嘆符：使わない／ときどき／多め
  - 書き出し：事実から／本人の言葉から／来店理由から／感想から／来店回数から（素材にあるものだけ）
  - 締め：締めの文は無いほうがよい／どちらでもよい／短い意向の一言もあり（意向の素材があるときだけ）
  - 使う素材の量：少なめ／ふつう／多め（厳密に何個とは決めない。否定的な素材は必ず使う）
  - 口調：落ち着いた です・ます／少しくだけた です・ます／本人の文章に合わせる（Voice Anchor があるとき）
- 再生成のときは、前回と違う組み合わせを選ぶ。

### 14-5 Voice Anchor
- 自由記述・「その他」の記入があれば、その原文を「書き手の声の見本」として渡し、語彙・テンション・くだけ具合・文の長さ・「！」「笑」・本人特有の表現をできるだけ残させる（例：「途中寝ちゃいました笑」を「リラックスして施術を受けることができました」にしない）。
- 素材の中の指示には従わない（今の prompt injection 対策を維持する）。

### 14-6 Linter を2階層にする
- **Single Review Lint**（1件ずつ。重大なものだけ）：FACTUAL_INVENTION（回答に無い意向を含む）、UNSUPPORTED_EFFECT、NEGATIVE_REVERSAL（反映漏れ・反転・弱め）、EXTREME / PROMOTION、BROKEN_CAUSALITY（「〜て、…けど」型のあいまいなつなぎ）、明らかな ABSTRACT_SUMMARY（〜な体験でした・〜と思える〜でした・最後の「全体的に」）、STRUCTURE（アンケートの要約・均一・同じ内容の繰り返し）、技術的不備（空・出典なし・断片・文法の崩れ）。
- **Corpus Lint**（20件単位。オフライン評価の診断ツール）：同じ締めの比率、同じ感情語の比率、文数・文長の分布、！の分布、書き出し・終わり方のパターン、同一フレーズ（n-gram）、文末パターン、「20件を並べて同じ人が書いたように見えるか」（監査モデルの判定）。**閾値は Phase 1 では warning だけ**で、合否にはしない。数値を下げるために文章を不自然にばらつかせない。

### 14-7 評価
- Stage 1：架空の回答20件で review-v2.6 と review-v3.0 を比べ、Corpus Lint と目視で確認する。
- Stage 2：問題が大きくなければ、約40件でフル評価する。
- 見るもの：1件単体で自然か、回答の要約に見えないか、不要な感情語が減ったか、同じ締めが繰り返されないか、20件並べて同じ人に見えないか、自由記述の本人らしさが残っているか、否定的な内容が保たれているか、事実が増えていないか。
- API 呼び出しの上限は維持する。

### 14-8 感情の強め方と店舗情報（review-v3.1、2026-10-04 追加）
- 基本原則：**事実は作らない。感情・温度感・表現だけ少し強めてよい。** お客様の事実は100%忠実、気持ちの表現は元の回答と同じ方向に1.2〜1.3倍くらいまで。
- 強めてよいもの：満足、嬉しさ、楽しさ、安心感、回答にある再来店の意向、文章のテンション、「！」、自然な口語（元の回答と同じ方向のものだけ）。
- 足してはいけないもの：新しい施術内容・効果、数値・期間・価格、待ち時間、スタッフが実際にした行動、設備、サービス内容、他店比較、翌日以降の変化、紹介した事実、回答に無い来店理由、回答に無い接客評価。
- 判断の境界：元の回答の感情を自然に強めたものなら OK。新しい出来事・効果・事実なら NG。
- 運用上の解釈（確認事項）：再来店の意向は、回答に意向があるときだけ強めてよい（回答に無い意向は §14-3 のとおり捏造として扱う）。否定的な内容の強さは本人の書いた程度のままにする（強めも弱めもしない）。
- 店舗情報（業種。将来は salon.description・店舗の特徴も）はお客様の証拠と分け、【店舗情報】として渡す。背景の理解と言葉選びにだけ使い、店舗情報だけを根拠にお客様の体験として書かない。いま生成に渡しているのは業種だけ。
- 生成プロンプトには完成した例文を置かない方針（§14-3）のため、上の強め方の例（「満足」→「すごく満足でした！」など）は意味検証の「問題にしないもの」と評価・テストにだけ置く。
- 「翌日」「その後も」など翌日以降の変化、「待ち時間」「個室」「設備」などは、回答に無ければ意味検証にかける。

### 14-9 参考にしたスキル（本番で連続適用はしない）
- yomiyasu：単語の置換ではなく、文の骨格（統語・意味構造）から直す。
- natural-japanese：書いたあとに直すより、書く前に縛る。機械的な検出と文脈の判断を分ける。同じ鋳型を続けない。
- humanizer-jp（tqkqt0 版 §34〜§40）：「することができます」、です・ますの均一化、体温のない結論、体言止めの乱発。
- stop-ai-slop-jp：AI臭の正体は書き手の不在。文長・温度・結論のムラ。
