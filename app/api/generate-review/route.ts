import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const surveyAnswersSchema = z.object({
  concerns: z.array(z.string()).min(1).max(3),
  skinImpressions: z.array(z.string()).min(1).max(3),
  treatmentImpressions: z.array(z.string()).min(1).max(3),
  salonImpressions: z.array(z.string()).min(1).max(3),
  freeText: z.string().max(300),
});

const SYSTEM_PROMPT = `あなたは美容サロンの口コミ文章を整える編集アシスタントです。

これから渡される情報は、
実際にハーブピーリングサロンを利用したお客様本人が回答したアンケートです。

アンケート回答のみを根拠として、
Google口コミに使用できる自然な日本語の下書きを作成してください。

必ず以下を守ってください。

・ユーザーが選択または入力していない内容を追加しない
・存在しない施術内容を作らない
・存在しない接客内容を作らない
・効果を誇張しない
・医療的な効果を断定しない
・「治った」「完治」「必ず改善」などの断定表現を使用しない
・肌の変化は本人の感想として表現する
・広告文章のようにしない
・サロン側が書いたような文章にしない
・自然な一般利用者の口コミにする
・過剰に褒めない
・同じ表現を繰り返さない
・100〜180文字程度を基本とする
・絵文字を使用しない
・星評価を文章内に入れない
・Googleへの投稿を促す文章を生成しない

例：

NG：
「ニキビが完全に治りました」

OK：
「施術後は肌がなめらかになったように感じました」

NG：
「絶対におすすめのサロンです」

OK：
「初めてでも安心して施術を受けられました」

自由記述がある場合は、
本人の言葉を優先して自然に文章へ組み込んでください。

文章だけを返してください。`;

const GENERIC_ERROR = "口コミの作成に失敗しました。もう一度お試しください。";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "リクエストの形式が正しくありません。" },
      { status: 400 },
    );
  }

  const parsed = surveyAnswersSchema.safeParse(body);
  if (!parsed.success) {
    console.error("Invalid survey answers payload", parsed.error.flatten());
    return NextResponse.json(
      { error: "リクエストの形式が正しくありません。" },
      { status: 400 },
    );
  }
  const answers = parsed.data;

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) {
    console.error("Missing OPENAI_API_KEY or OPENAI_MODEL env var");
    return NextResponse.json(
      { error: "サーバー設定エラーが発生しました。しばらくしてから再度お試しください。" },
      { status: 500 },
    );
  }

  const userMessage = [
    `お悩み: ${answers.concerns.join("、")}`,
    `施術後の感想: ${answers.skinImpressions.join("、")}`,
    `施術について: ${answers.treatmentImpressions.join("、")}`,
    `スタッフ・サロンについて: ${answers.salonImpressions.join("、")}`,
    answers.freeText ? `自由記述: ${answers.freeText}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!openaiRes.ok) {
      console.error("OpenAI API error", openaiRes.status, await openaiRes.text());
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
    }

    const data = await openaiRes.json();
    const review = data?.choices?.[0]?.message?.content?.trim();
    if (!review) {
      console.error("OpenAI response missing review content", data);
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
    }

    return NextResponse.json({ review });
  } catch (err) {
    console.error("Failed to call OpenAI API", err);
    const status = err instanceof Error && err.name === "TimeoutError" ? 504 : 502;
    return NextResponse.json({ error: GENERIC_ERROR }, { status });
  }
}
