# salonpack

複数のサロンが、それぞれ専用のアンケート・専用URLでGoogle口コミの下書き作成をお客様に提供できるサービスです。

お客様は`/review/{ページURL}`を開いてアンケートに回答するだけで、その回答内容だけをもとにOpenAI APIが口コミ文章の下書きを生成します。生成された文章はお客様本人が内容を確認・編集し、コピーしてからGoogleの口コミ投稿ページへ移動して、ご自身で投稿します。**Googleへの自動投稿は行いません。**

サロンオーナーは`/login`にログインし、`/dashboard`から店舗情報・アンケート内容・Google口コミURLを自分で管理できます（旧`/admin`系のURLはそれぞれ対応する新URLへリダイレクトされます）。

## ブランチについて

- `master`: 単一店舗版の安定版（このREADMEの内容は対象外）
- `feature/multi-salon-admin`: このREADMEが対象とする複数店舗対応版

## 使い方の流れ

**一般のお客様（ログイン不要）**
1. サロンから送られた専用URL（`/review/{ページURL}`）を開く
2. アンケートに回答する（STEP1）
3. 「AIで口コミを作成する」を押すと、サーバー経由でOpenAI APIが口コミ文章を生成する
4. 生成された文章を確認・編集する（STEP2）
5. 「口コミをコピーする」でクリップボードにコピーする
6. 「Google口コミページを開く」でそのサロンのGoogle口コミ投稿ページへ移動する（STEP3）
7. コピーした文章を貼り付けて、お客様自身が投稿する

**サロンオーナー（ログイン必要）**
1. `/login` からログイン
2. 初回は店舗情報登録→アンケートテンプレート選択→（必要なら質問編集）→Google口コミURL登録、の順に案内される
3. 完成すると自店舗専用のお客様用URLが発行される
4. 以後は `/dashboard` から店舗設定・アンケート内容をいつでも編集できる

## セットアップ

```bash
npm install
cp .env.example .env.local
```

`.env.local` に実際の値を設定してください（詳細は下記「環境変数」を参照）。

```bash
npm run dev
```

[http://localhost:3000](http://localhost:3000) で確認できます（未ログインなら自動的に `/login` へ移動します）。

## 環境変数

| 変数名 | 説明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAIのAPIキー。サーバーサイド（`app/api/generate-review/route.ts`）でのみ使用され、ブラウザには一切露出しません。 |
| `OPENAI_MODEL` | 口コミ生成に使用するモデル名（例: `gpt-4o-mini` など）。 |
| `NEXT_PUBLIC_SUPABASE_URL` | SupabaseプロジェクトのURL（Project Settings → API から取得）。クライアントからも参照するため公開情報として扱われます。 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabaseのanon（公開）キー。RLSで保護されている前提の、クライアントに露出して問題ないキーです。 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabaseのservice_role（秘密）キー。**このアプリのコードからは一切使用していません**（すべての操作はオーナー自身の認証セッション＋RLSで行う設計のため）。将来、手動運用のスクリプト等で必要になった場合に備えて予約している変数です。**絶対にクライアントに露出させないでください。** |

`.env.local` はGit管理対象外です。Vercelのプレビュー環境（`feature/multi-salon-admin`ブランチ）・本番環境それぞれのプロジェクト設定で、同じ環境変数を設定してください。

## Supabaseプロジェクトの作成方法

1. [supabase.com](https://supabase.com) でアカウントを作成し、新規プロジェクトを作成する
2. Project Settings → API から `Project URL`（`NEXT_PUBLIC_SUPABASE_URL`）と `anon public` キー（`NEXT_PUBLIC_SUPABASE_ANON_KEY`）を控える
3. 同じ画面の `service_role` キーも控えておく（`SUPABASE_SERVICE_ROLE_KEY`、上記の通りアプリからは未使用）

## マイグレーションの適用方法

`supabase/migrations/` にテーブル定義・RLSポリシー・関数がSQLファイルとして入っています。[Supabase CLI](https://supabase.com/docs/guides/cli) を使う場合:

```bash
supabase link --project-ref <あなたのプロジェクトref>
supabase db push
```

CLIを使わない場合は、Supabaseダッシュボードの SQL Editor で `supabase/migrations/` 内のファイルを`0001`から順番に実行してください。

## Seedデータの適用方法

`supabase/seed.sql` に、テンプレート一覧（ハーブピーリング／エステ・フェイシャル／整体・マッサージ／美容室／ネイルサロン／アイラッシュ・眉毛）の初期データが入っています。

```bash
supabase db reset   # ローカル開発環境の場合。migration+seedを両方適用します
```

または、Supabaseダッシュボードの SQL Editor に `supabase/seed.sql` の内容を貼り付けて実行してください。現行の標準6件を追加し、旧標準テンプレートを削除します。独自テンプレートと各店舗へコピー済みの質問は残します。既存環境では、古いテンプレートIDの操作も防ぐ `0019_positive_review_templates.sql` を適用してください。

## サロンオーナーアカウントの作成方法

このアプリには公開のサインアップページはありません。オーナーアカウントは、サービス運営者がSupabaseダッシュボードから手動で発行します。

1. Supabaseダッシュボード → Authentication → Users → **Add user** で、オーナーのメールアドレス・パスワードを設定してユーザーを作成
2. 作成すると自動的に`profiles`テーブルに対応する行が作られます（DBトリガーによる自動処理）
3. オーナーへログイン情報（メールアドレス・パスワード）を共有する
4. オーナーが`/login`からログインすると、初回は店舗情報登録のウィザードが表示されます

## OpenAI API設定について

- OpenAI APIの呼び出しは必ずサーバーサイド（`app/api/generate-review/route.ts`）から行われ、APIキーがクライアントに渡ることはありません。
- 口コミ生成時のシステムプロンプトは同ファイル内の`buildSystemPrompt`関数で組み立てられます。業種を問わず全サロン共通で使用され、誇張表現やAIっぽい定型文を避け、アンケート回答のみを根拠に自然な文章を作成するよう指示しています。文章の構成（`STRUCTURE_PATTERNS`）と参考例（`REVIEW_EXAMPLES`）は生成のたびにサーバー側でランダムに選ばれ、毎回同じ言い回しに偏らないようにしています。
- `OPENAI_API_KEY`または`OPENAI_MODEL`が未設定の場合は、エラーにならずユーザーに分かりやすいメッセージを表示します。
- お客様のアンケート回答（ユーザー入力）は常に`user`ロールのメッセージとして送信され、`system`ロールのプロンプト文字列に混ぜ込むことはありません。

## Vercel側で必要な設定

1. GitHubリポジトリをVercelにインポート（`feature/multi-salon-admin`ブランチをデプロイ対象にする場合はVercel側でPreview/Productionブランチの設定を調整してください）
2. Environment Variablesに上記5つの変数（`OPENAI_API_KEY`/`OPENAI_MODEL`/`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`）を設定する
3. Deployを実行する

## 既存店舗（ハーブピーリングサロン）をこのシステムへ移行する手順

`master`ブランチで運用していた1店舗版から、このマルチテナント版へ切り替える際の手順です（`feature/multi-salon-admin`が`master`にマージされ本番昇格した後に実施してください）。

1. Supabaseダッシュボードでオーナーアカウントを手動発行（上記「サロンオーナーアカウントの作成方法」参照）
2. `/login`でログインし、オンボーディングウィザードで店舗名を登録
3. テンプレート選択で「ハーブピーリング」を選ぶ（生成される質問は現行の最新版と一致する内容です）
4. 質問編集は不要ならそのままスキップ
5. これまで`NEXT_PUBLIC_GOOGLE_REVIEW_URL`に設定していたURLをGoogle口コミURLとして登録
6. 発行された`/review/{ページURL}`で一通り動作確認する
7. Vercelの環境変数から`NEXT_PUBLIC_GOOGLE_REVIEW_URL`を削除する（もう使用されません）

なお、ルート（`/`）は今後すべてのサロン共通の管理画面入口になるため、旧来の裸のルートURLへアクセスしていたお客様向けの自動リダイレクトは用意していません。今後は`/review/{ページURL}`を新しいお客様用URLとして案内してください。

## ディレクトリ構成

```
app/
  page.tsx                          ルート（ログイン状態に応じて/dashboardまたは/loginへ）
  review/[slug]/page.tsx            お客様用アンケート画面（サロンごとに動的生成）
  api/generate-review/route.ts      OpenAI APIを呼び出すサーバーサイドAPI
  (auth)/login/page.tsx             オーナーログイン画面
  (auth)/forgot-password/page.tsx   パスワード再設定（メール送信）
  (auth)/reset-password/page.tsx    パスワード再設定（新パスワード設定・初回パスワード設定を兼ねる）
  dashboard/                        ログイン必須の管理画面（layout.tsx で認証ゲート、Sidebar/BottomNavのシェル）
    page.tsx                        ホーム（口コミ/ブログ/予約通知の入口）
    settings/                       店舗設定
    reviews/                        口コミ（アンケート設定・お客様用URL）
    blog/                           ブログ（準備中プレースホルダー、blog-app未連携）
    notifications/                  予約通知（準備中プレースホルダー、hmail未連携）
  admin/                            旧URL互換のリダイレクトのみ（/dashboard系へ）
components/
  ui/                               共通デザインシステム（Button/Card/Input/Alert/Toast/Skeleton等）
  layout/                           Sidebar・BottomNav・ProfileMenu・DashboardShell
  dashboard/                        ホーム画面のFeatureCard等
  auth/                             ログイン・パスワード再設定フォーム
  review/                           お客様向け画面のコンポーネント一式
  admin/                            アンケート編集・店舗設定フォーム等
  Toast.tsx                         共通トースト通知（review/dashboard両方で使用）
lib/
  types.ts                          共有の型定義（質問・回答・サロン情報）
  constants.ts                      共有定数
  brand.ts                          サービス名・タグライン（正式名称確定までの仮定数）
  cn.ts                             クラス名結合の小ユーティリティ
  supabase/                         Supabaseクライアント（ブラウザ／サーバー／proxy用）・共通クエリ
supabase/
  migrations/                       テーブル・RLS・関数のマイグレーション
  seed.sql                          テンプレート初期データ
proxy.ts                            認証セッションのリフレッシュ＋/dashboard配下の未ログインリダイレクト
```

## セキュリティ設計の要点

- OpenAI APIキー・Supabaseの`service_role`キーはいずれもクライアントへ一切露出しません。
- 全テーブルでRow Level Securityを有効化しています。サロンオーナーは自分が所有する店舗のデータのみ閲覧・編集可能で、他店舗のデータには一切アクセスできません（詳細は`supabase/migrations/`のRLSポリシーを参照）。
- 一般公開されるのは、店舗名・ページURL・Google口コミURL・店舗説明・有効なアンケート内容のみです。オーナーのユーザー情報や店舗の所有者情報（`owner_id`）は、専用のビュー（`salon_public`）を介してのみ公開され、非公開カラムが漏れることはありません。
- 管理画面のすべての書き込み操作は、リクエストに含まれるIDを鵜呑みにせず、必ずログイン中のユーザー自身のセッションから「自分の店舗」を都度サーバー側で解決してから実行します。

## このバージョンでまだ実装していないもの

Stripe決済・月額プラン・口コミ件数の分析ダッシュボード・Google Business Profile API連携・LINE/Instagram連携・メール配信・AIによるアンケート自動作成・スタッフ権限管理・1アカウントでの複数店舗の高度な組織管理・店舗ごとの独自ドメイン設定・サロンオーナーの公開セルフサインアップは、いずれもこのバージョンのスコープ外です。
