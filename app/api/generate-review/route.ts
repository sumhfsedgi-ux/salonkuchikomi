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

// A larger pool than what's shown per-call: sampling a random subset each
// time keeps the model from anchoring on the exact same phrasing every
// generation (unlike before, which hardcoded the same 3 examples on every
// single call). Kept business-type-agnostic (hair/esthetic/nail/massage/
// eyelash/herb-peel all share this file) — no treatment-specific nouns.
// A few examples use "！" once, and a few use a line break between two
// thoughts, so this teaches punctuation/line-break variety implicitly
// instead of via another prescriptive rule.
const REVIEW_EXAMPLES = [
  "ずっと気になっていたので思い切って予約しました。説明が分かりやすくて、施術中も安心してお任せできました。終わった後は気分がすっきりして嬉しかったです。",
  "担当してくれたスタッフさんがとても話しやすい方で、施術中も色々相談に乗ってもらえました！おかげで楽しい時間を過ごせました。",
  "仕事帰りに時間を作って寄らせてもらいました。\n初めての利用でしたが要望をしっかり聞いてもらえて、仕上がりも自分好みになって満足しています。",
  "前々から気になっていたお店で、やっと予約が取れたので行ってきました。当日は丁寧に説明してもらえたので、安心してお願いできました。",
  "友人にすすめられて行ってみました。カウンセリングが丁寧で、自分の悩みをちゃんと聞いてもらえた気がします！施術後の感じにも満足しています。",
  "予約していた時間通りに案内してもらえて、待たされることもありませんでした。\n担当してくれた方の対応も落ち着いていて、話しやすかったです。",
  "以前から気になっていた点があり、思い切って相談してみました。丁寧に説明してもらえたので納得して施術をお願いできました。終わった後の感じにも満足しています。",
  "口コミの評価がよかったので、思い切って予約して伺いました！スタッフの方も感じがよく、最後までリラックスして過ごすことができました。",
  "急な予約だったのに快く対応してもらえて助かりました。当日の説明もとても分かりやすくて、初めての利用でも迷わずお願いすることができました。",
  "数年ぶりに利用させてもらいました。\n施術後のイメージについても相談にしっかり付き合ってもらえて、安心してお願いすることができました。",
  "接客はほどよい距離感で、居心地よく過ごすことができました。強引な勧誘なども特になく、とても好印象のまま帰ることができました。",
  "当日は少し緊張していましたが、スタッフさんが気さくに話しかけてくれてリラックスできました！\n終わった後の仕上がりにも満足しています。",
  "以前から気になっていたことを相談してみたところ、丁寧に対応してもらえました。また機会があればお願いしたいと思っています。",
  "初めての来店で少し緊張していましたが、丁寧に流れを説明してもらえたので落ち着いて過ごせました。終わった後の状態にも満足しています。",
  "お店の雰囲気が思っていたよりも良くて、それだけでも来てよかったと感じました。\n担当してくれた方の説明も分かりやすくて、安心できました。",
];

const EXAMPLES_PER_PROMPT = 3;

function pickRandomExamples(pool: string[], count: number): string[] {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function buildSystemPrompt(pattern: string, examples: string[]): string {
  const examplesBlock = examples.map((e, i) => `${i + 1}. ${e}`).join("\n\n");
  return `あなたは口コミを代筆するライターではありません。

ユーザー本人が回答したアンケートを、
本人がGoogle口コミに書きやすい自然な文章へ軽く整理する編集アシスタントです。

完成度の高い広告文章にしてはいけません。

【必ず守るルール】
・回答にない事実・体験・接客内容・業種やサービス内容を絶対に追加しない。ユーザーが書いていない「また行きたい」「おすすめです」などの感想を勝手に補って結ばない。回答が少ない・簡潔な場合は、無理に内容を補わず、書ける範囲で短くまとめる。
・医療的な効果を断定しない。「治った」「完治」「必ず改善」などの断定表現は使わない。
・絵文字は使用しない。
・星評価を文章内に入れない。
・他の人に投稿を促す文章（「みなさんもぜひ」など）を生成しない。

【自然な文章にするために】
・完成度の高い広告文やお店の紹介文のように整えすぎない。AI特有の隙のない丁寧な文章にしない。
・回答の中から自然に重要な2〜4点程度を選んで書く。すべてを無理に詰め込まない。
・一文を長くしすぎない。接続詞の多用や「〜でした。〜でした。」のような機械的な文末の繰り返しを避ける。
・ユーザー本人の言葉を優先する。自由記述がある場合は、その言い回しや温度感をできるだけ残す。

【避けたいAIっぽい表現】
以下の表現は必要な場合を除いて極力使用しない（禁止ではないが、毎回定型文のように使わない）。
「とても満足しています」「安心して施術・サービスを受けることができました」「丁寧に対応していただきました」
「清潔感のある店内でした」「また利用したいと思います」「おすすめしたいお店です」
「初めての方にもおすすめです」「終始リラックスして過ごすことができました」
「親身になって相談に乗ってくださいました」「素敵な時間を過ごすことができました」

【文章量】
基本は80〜160文字程度。情報量が少ない場合は無理に文字数を増やさない。短い自然な口コミでも問題ない。

【口コミごとに変化をつける】
今回は次の構成で書いてください: ${pattern}
必ずすべてのアンケート項目を文章に入れる必要はない。

【語尾・文末】
「〜でした」「〜です」「〜感じました」「〜よかったです」などを自然に混ぜ、同じ語尾や敬語レベルに揃えすぎない（砕けすぎた表現や若者言葉は追加しない）。句読点も毎回「。」だけで揃えず、下の参考例のように「！」や改行を時々自然に使ってよい。

【参考例】
あくまで文体・自然さの参考。内容やエピソードはそのまま流用せず、実際の文章はアンケートの回答内容だけをもとに作成すること。

${examplesBlock}

【NG例】
「悩みが気になり来店しました。スタッフの方が親身になって相談に乗ってくださり、安心して施術を受けることができました。終わった後はとても満足しています。またぜひ利用したいと思います。」
→ 定型文が多く、AI口コミっぽい。

最終的に、「AIが考えた口コミ」ではなく「本人の回答を本人っぽく整理した口コミ」になることを最優先してください。

文章だけを返してください。`;
}

const GENERIC_ERROR = "口コミの作成に失敗しました。もう一度お試しください。";

// On sparse/ambiguous answers the model occasionally returns a meta
// response ("申し訳ありませんが、その情報からは...") instead of a review, or
// confidently hallucinates an unrelated business type (a café/restaurant
// review, since that's an extremely common review "shape" in training
// data). Neither of these should ever reach the editable textarea the
// customer sees, so we detect them and retry once with a fresh random
// pattern/example selection before giving up. This is a narrow safety net,
// not a general fix — it won't catch every kind of off-topic drift (e.g.
// a massage-style review bleeding into a hair-salon answer), because the
// API currently has no way to know the salon's business category at all.
const REFUSAL_PATTERN = /^(申し訳ございません|申し訳ありません|すみません|ごめんなさい)/;
const OFF_TOPIC_PATTERN = /スイーツ|カフェ|レストラン|ランチ|ディナー|コーヒー|ケーキ|美味し|ドリンクメニュー|フードメニュー/;

function isInvalidReview(review: string): boolean {
  return REFUSAL_PATTERN.test(review) || OFF_TOPIC_PATTERN.test(review);
}

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

  const generate = async (): Promise<
    { review: string } | { errorResponse: NextResponse }
  > => {
    const pattern =
      STRUCTURE_PATTERNS[Math.floor(Math.random() * STRUCTURE_PATTERNS.length)];
    const examples = pickRandomExamples(REVIEW_EXAMPLES, EXAMPLES_PER_PROMPT);
    const systemPrompt = buildSystemPrompt(pattern, examples);

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
          temperature: 1.0,
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
      return {
        errorResponse: NextResponse.json({ error: GENERIC_ERROR }, { status: 502 }),
      };
    }

    const data = await openaiRes.json();
    const review = data?.choices?.[0]?.message?.content?.trim();
    if (!review) {
      console.error("OpenAI response missing review content", salonId, data);
      return {
        errorResponse: NextResponse.json({ error: GENERIC_ERROR }, { status: 502 }),
      };
    }

    return { review };
  };

  try {
    let result = await generate();

    if ("review" in result && isInvalidReview(result.review)) {
      console.error(
        "OpenAI returned a refusal-like or off-topic response, retrying once",
        salonId,
        result.review,
      );
      result = await generate();
    }

    if ("errorResponse" in result) {
      return result.errorResponse;
    }
    if (isInvalidReview(result.review)) {
      console.error(
        "OpenAI kept returning a refusal-like or off-topic response",
        salonId,
        result.review,
      );
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
    }

    return NextResponse.json({ review: result.review });
  } catch (err) {
    console.error("Failed to call OpenAI API", salonId, err);
    const status = err instanceof Error && err.name === "TimeoutError" ? 504 : 502;
    return NextResponse.json({ error: GENERIC_ERROR }, { status });
  }
}
