import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  salonId: z.string().uuid(),
  answers: z
    .array(
      z.object({
        question: z.string().max(200),
        answer: z.union([z.string().max(100), z.array(z.string().max(100)).max(10)]),
      }),
    )
    .max(20),
});

// Picked server-side (not left to the model) so structurally-identical
// survey answers still produce differently-shaped reviews instead of
// relying on the model to "randomly" vary on its own.
const STRUCTURE_PATTERNS = [
  "来店理由→施術・サービスの感想→接客の順で書く",
  "施術・サービスの感想→来店理由→一言の順で書く",
  "自由記述を中心にする",
  "施術・サービス＋スタッフだけを書く",
  "2〜3文程度の短い口コミにする",
];

function buildSystemPrompt(pattern: string): string {
  return `あなたは口コミを代筆するライターではありません。

ユーザー本人が回答したアンケートを、
本人がGoogle口コミに書きやすい自然な文章へ軽く整理する編集アシスタントです。

完成度の高い広告文章にしてはいけません。

【最重要ルール】

・文章を綺麗に整えすぎない
・広告コピーのような文章にしない
・お店の紹介文のようにしない
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
・存在しない体験や接客内容を作らない
・医療的な効果を断定しない
・「治った」「完治」「必ず改善」などの断定表現を使用しない
・絵文字を使用しない
・星評価を文章内に入れない
・投稿を促す文章を生成しない

【避けたいAIっぽい表現】
以下の表現は必要な場合を除いて極力使用しない（禁止ではないが、毎回定型文のように使わない）。
「とても満足しています」「安心して施術・サービスを受けることができました」「丁寧に対応していただきました」
「清潔感のある店内でした」「また利用したいと思います」「おすすめしたいお店です」
「初めての方にもおすすめです」「終始リラックスして過ごすことができました」
「親身になって相談に乗ってくださいました」「素敵な時間を過ごすことができました」

【文章の雰囲気】
一般のお客様が利用後にスマートフォンで書く口コミを想定する。プロのライターのように仕上げる必要はない。
例：「ずっと気になっていたことがあって伺いました。利用するのは初めてでしたが、説明も分かりやすかったです。終わった後は気分がすっきりして嬉しかったです。」
この程度の自然さで十分。

【文章量】
基本は80〜160文字程度。情報量が少ない場合は無理に文字数を増やさない。短い自然な口コミでも問題ない。

【口コミごとに変化をつける】
今回は次の構成で書いてください: ${pattern}
必ずすべてのアンケート項目を文章に入れる必要はない。

【語尾】
「〜でした」「〜です」「〜感じました」「〜嬉しかったです」「〜よかったです」「〜気になっていました」などを自然に混ぜる。すべての文章を同じ敬語レベルに揃えすぎない。ただし砕けすぎた表現や若者言葉を勝手に追加しないこと。

【NG例】
「悩みが気になり来店しました。スタッフの方が親身になって相談に乗ってくださり、安心して施術を受けることができました。終わった後はとても満足しています。またぜひ利用したいと思います。」
→ 綺麗すぎる、定型文が多い、AI口コミっぽい。

【OK例】
「ずっと気になっていたので予約しました。利用するのは初めてでしたが、説明が分かりやすくてよかったです。終わった後はすっきりした感じがしました。」

【別のOK例】
「気になっていたことがあって行きました。スタッフさんも話しやすくて、いろいろ相談できました。終わった後の感じもよかったです。」

【さらに短い例】
「初めての利用でした。説明も丁寧で、終わった後は気分がすっきりしました。また様子を見てお願いしたいです。」

【重要】
アンケートの回答内容によっては、最後に「また行きたい」「おすすめです」などを付けなくて構わない。ユーザーが回答していないポジティブな感想を勝手に補完しないこと。

最終的に、「AIが考えた口コミ」ではなく「本人の回答を本人っぽく整理した口コミ」になることを最優先してください。

文章だけを返してください。`;
}

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

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    console.error("Invalid generate-review payload", parsed.error.flatten());
    return NextResponse.json(
      { error: "リクエストの形式が正しくありません。" },
      { status: 400 },
    );
  }
  const { salonId, answers } = parsed.data;

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) {
    console.error("Missing OPENAI_API_KEY or OPENAI_MODEL env var");
    return NextResponse.json(
      { error: "サーバー設定エラーが発生しました。しばらくしてから再度お試しください。" },
      { status: 500 },
    );
  }

  const userMessage = answers
    .map(({ question, answer }) => {
      const answerText = Array.isArray(answer) ? answer.join("、") : answer;
      return answerText ? `${question}: ${answerText}` : null;
    })
    .filter(Boolean)
    .join("\n");

  const pattern =
    STRUCTURE_PATTERNS[Math.floor(Math.random() * STRUCTURE_PATTERNS.length)];
  const systemPrompt = buildSystemPrompt(pattern);

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
          temperature: 1.15,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!openaiRes.ok) {
      console.error(
        "OpenAI API error",
        salonId,
        openaiRes.status,
        await openaiRes.text(),
      );
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
    }

    const data = await openaiRes.json();
    const review = data?.choices?.[0]?.message?.content?.trim();
    if (!review) {
      console.error("OpenAI response missing review content", salonId, data);
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
    }

    return NextResponse.json({ review });
  } catch (err) {
    console.error("Failed to call OpenAI API", salonId, err);
    const status = err instanceof Error && err.name === "TimeoutError" ? 504 : 502;
    return NextResponse.json({ error: GENERIC_ERROR }, { status });
  }
}
