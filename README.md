# salonpack

ハーブピーリングサロンのお客様向けに、Google口コミの下書きをAIが作成するサポートツールです。

お客様がアンケートに回答すると、その回答内容だけをもとにOpenAI APIが口コミ文章の下書きを生成します。生成された文章はお客様本人が内容を確認・編集し、コピーしてからGoogleの口コミ投稿ページへ移動して、ご自身で投稿します。**Googleへの自動投稿は行いません。**

## 使い方の流れ

1. お客様がURLを開く
2. アンケートに回答する（STEP1）
3. 「AIで口コミを作成する」を押すと、サーバー経由でOpenAI APIが口コミ文章を生成する
4. 生成された文章を確認・編集する（STEP2）
5. 「口コミをコピーする」でクリップボードにコピーする
6. 「Google口コミページを開く」でGoogleの口コミ投稿ページへ移動する（STEP3）
7. コピーした文章を貼り付けて、お客様自身が投稿する

## セットアップ

```bash
npm install
cp .env.example .env.local
```

`.env.local` に実際の値を設定してください（後述）。

```bash
npm run dev
```

[http://localhost:3000](http://localhost:3000) で確認できます。

## 環境変数

| 変数名 | 説明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAIのAPIキー。サーバーサイド（`app/api/generate-review/route.ts`）でのみ使用され、ブラウザには一切露出しません。 |
| `OPENAI_MODEL` | 口コミ生成に使用するモデル名（例: `gpt-4o-mini` など）。コストや文章品質に応じて調整してください。 |
| `NEXT_PUBLIC_GOOGLE_REVIEW_URL` | 対象店舗のGoogle口コミ投稿ページのURL。STEP3の「Google口コミページを開く」ボタンの遷移先として、クライアント側で使用するため `NEXT_PUBLIC_` が必要です。 |

`.env.local` はGit管理対象外です。本番・プレビュー環境ではVercelのプロジェクト設定で同じ3つの環境変数を設定してください。

## OpenAI API設定について

- OpenAI APIの呼び出しは必ずサーバーサイド（Route Handler）から行われ、APIキーがクライアントに渡ることはありません。
- 口コミ生成時のシステムプロンプトは `app/api/generate-review/route.ts` 内の `SYSTEM_PROMPT` に定義されています。誇張表現や医療的な断定表現を避け、アンケート回答のみを根拠に文章を作成するよう指示しています。
- `OPENAI_API_KEY` または `OPENAI_MODEL` が未設定の場合は、エラーにならずユーザーに分かりやすいメッセージ（「サーバー設定エラーが発生しました。」）を表示します。

## Google口コミURLの設定方法

`NEXT_PUBLIC_GOOGLE_REVIEW_URL` に、対象店舗のGoogle口コミ投稿ページのURLを設定してください。Googleビジネスプロフィールの管理画面から「クチコミ収集リンクを取得」で発行できるURLなどを利用できます。

## 店舗名の変更方法

[`config/salon.ts`](config/salon.ts) の `salonConfig.name` を変更してください。ファーストビューに表示される店舗名がこの値になります。

```ts
export const salonConfig: SalonConfig = {
  name: "〇〇 Herb Peeling Salon",
};
```

## アンケート項目の変更方法

[`config/survey.ts`](config/survey.ts) の `surveyQuestions` 配列を編集してください。各質問は以下の形式で定義します。

- `id`: 回答を保持するキー名（`SurveyAnswers` のキーと一致させる必要があります）
- `question`: 質問文
- `required`: 必須かどうか
- `type`: `"multi-select"`（複数選択）または `"textarea"`（自由記述）
- `multi-select` の場合: `options`（選択肢一覧）、`maxSelections`（最大選択数）
- `textarea` の場合: `placeholder`（任意）、`maxLength`（最大文字数）

将来的にエステ・ネイル・マッサージ・美容室など他業態へ展開する場合は、この `surveyQuestions` 配列を業態に合わせて丸ごと差し替えるだけで、コンポーネント側のコードを変更せずに対応できます。ただし質問構成（`id`）を大きく変える場合は、`SurveyAnswers` 型とAPIルート内の文章組み立て処理も合わせて更新してください。

## コンポーネント構成

```
app/
  page.tsx                     ステップ管理を行うメイン画面
  api/generate-review/route.ts OpenAI APIを呼び出すサーバーサイドAPI
components/
  Hero.tsx                     ファーストビュー（店舗名・キャッチコピー）
  ReviewStepper.tsx             STEP1〜3の進捗表示
  SurveyForm.tsx                アンケート全体のフォーム
  QuestionCard.tsx              質問1件分のカード
  MultiSelectQuestion.tsx       複数選択形式の質問
  TextareaQuestion.tsx          自由記述形式の質問
  ReviewLoading.tsx             AI生成中のローディング表示
  GeneratedReview.tsx           生成された口コミの確認・編集・コピー
  GoogleReviewGuide.tsx         Google口コミページへの案内（STEP3）
  Toast.tsx                     コピー成功などの通知
config/
  salon.ts                      店舗情報
  survey.ts                     アンケート項目の定義
```

## Vercelへのデプロイ

```bash
git init   # 未実施の場合
git add .
git commit -m "Initial commit"
```

1. GitHubなどにリポジトリを作成し、push する
2. [Vercel](https://vercel.com) で新規プロジェクトとしてインポートする
3. プロジェクト設定の Environment Variables に `OPENAI_API_KEY` / `OPENAI_MODEL` / `NEXT_PUBLIC_GOOGLE_REVIEW_URL` を Production / Preview の両方に設定する
4. Deploy を実行する

## このMVPでできないこと（意図的に未実装）

ログイン、会員登録、管理画面、決済、顧客管理、口コミ分析、Google Business Profile API連携、LINE/Instagram連携、データベース、複数店舗管理は、このMVPのスコープ外です。
