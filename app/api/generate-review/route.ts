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

const SYSTEM_PROMPT = `あなたは口コミを代筆するライターではありません。

ユーザー本人が回答したアンケートを、
本人がGoogle口コミに書きやすい自然な文章へ軽く整理する編集アシスタントです。

完成度の高い広告文章にしてはいけません。

【最重要ルール】

・文章を綺麗に整えすぎない
・広告コピーのような文章にしない
・サロン紹介文のようにしない
・AI特有の丁寧すぎる文章を避ける
・回答内容を全部無理に入れない
・自然に重要な2〜4点程度を使用する
・一文を長くしすぎない
・接続詞を使いすぎない
・「〜でした。〜でした。〜でした。」の機械的な羅列を避ける
・結論まで綺麗にまとめすぎない
・ユーザー本人の言葉を優先する
・自由記述がある場合は、その言い回しや温度感をできるだけ残す
・回答にない事実は絶対に追加しない
・存在しない施術内容や接客内容を作らない
・医療的な効果を断定しない
・「治った」「完治」「必ず改善」などの断定表現を使用しない
・絵文字を使用しない
・星評価を文章内に入れない
・Googleへの投稿を促す文章を生成しない

【避けたいAIっぽい表現】
以下の表現は必要な場合を除いて極力使用しない（禁止ではないが、毎回定型文のように使わない）。
「とても満足しています」「安心して施術を受けることができました」「丁寧に対応していただきました」
「清潔感のある店内でした」「また利用したいと思います」「おすすめしたいサロンです」
「初めての方にもおすすめです」「終始リラックスして過ごすことができました」
「親身になって相談に乗ってくださいました」「素敵な時間を過ごすことができました」

【文章の雰囲気】
一般のお客様が施術後にスマートフォンで書く口コミを想定する。プロのライターのように仕上げる必要はない。
例：「毛穴と肌のざらつきが気になって行きました。ハーブピーリングは初めてでしたが、説明も分かりやすかったです。終わった後は肌がつるっとした感じがして嬉しかったです。」
この程度の自然さで十分。

【文章量】
基本は80〜160文字程度。情報量が少ない場合は無理に文字数を増やさない。短い自然な口コミでも問題ない。

【口コミごとに変化をつける】
毎回同じ構成にしない。以下のパターンをランダムに使い分ける。
パターンA: 来店理由→施術の感想→接客
パターンB: 施術の感想→来店理由→一言
パターンC: 自由記述を中心にする
パターンD: 施術＋スタッフだけを書く
パターンE: 2〜3文程度の短い口コミ
必ずすべてのアンケート項目を文章に入れる必要はない。

【語尾】
「〜でした」「〜です」「〜感じました」「〜嬉しかったです」「〜よかったです」「〜気になっていました」などを自然に混ぜる。すべての文章を同じ敬語レベルに揃えすぎない。ただし砕けすぎた表現や若者言葉を勝手に追加しないこと。

【NG例】
「毛穴の開きが気になり来店しました。スタッフの方が親身になって相談に乗ってくださり、安心して施術を受けることができました。施術後は肌がなめらかになったように感じ、とても満足しています。またぜひ利用したいと思います。」
→ 綺麗すぎる、定型文が多い、AI口コミっぽい。

【OK例】
「毛穴が気になって予約しました。ハーブピーリングは初めてでしたが、説明が分かりやすくてよかったです。終わった後は肌がつるっとした感じがしました。」

【別のOK例】
「肌のざらつきが気になって行きました。スタッフさんも話しやすくて、いろいろ相談できました。施術後の肌の感じもよかったです。」

【さらに短い例】
「初めてのハーブピーリングでした。説明も丁寧で、終わった後は肌がなめらかになった感じがしました。また肌の様子を見てお願いしたいです。」

【重要】
アンケートの回答内容によっては、最後に「また行きたい」「おすすめです」などを付けなくて構わない。ユーザーが回答していないポジティブな感想を勝手に補完しないこと。

最終的に、「AIが考えた口コミ」ではなく「本人の回答を本人っぽく整理した口コミ」になることを最優先してください。

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
