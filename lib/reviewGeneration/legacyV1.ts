import "server-only";
import type { V1Answer } from "@/lib/reviewGeneration/validateAnswers";

// v1 の口コミ生成。Phase 1 より前の app/api/generate-review/route.ts の処理を、そのまま移したもの。
// REVIEW_PIPELINE=v1(既定)のときに使う。v2 に切り替えて問題が無ければ削除する。
// 変えたのは次の2点だけで、プロンプト・モデル・temperature は変えていない:
//  ・店舗名・業種は、クライアントの値ではなく DB(salon_public)の値を使う(呼び出し元が渡す)。
//  ・ログに回答・生成した文章・OpenAI のエラー本文を出さない。

// Picked server-side (not left to the model) so structurally-identical
// survey answers still produce differently-shaped reviews instead of
// relying on the model to "randomly" vary on its own. On a fresh generation
// this is framed as optional inspiration (content should decide structure,
// not a dice roll); on a regenerate it's promoted to a mandate, since a
// vague "vary something" ask alone produced near-identical paraphrases
// across regenerations in testing (see buildSystemPrompt's structure
// section, branched on whether previousReview is present).
// Phrased as concrete "start with X" / "limit to N sentences" directives
// rather than abstract style labels -- testing showed the model largely
// ignored vaguer labels (e.g. "◯◯を中心に据えて書く構成") and defaulted to
// the same visit-reason→experience→staff chronological order regardless of
// which label was picked. Even with concrete directives, adherence is not
// 100% reliable (an inherent LLM instruction-following limitation) -- this
// is a meaningful improvement, not a guarantee.
const STRUCTURE_HINTS = [
  "最初の1文を、今回の口コミで最も伝えたい感想（中心とする内容）から書き始める。来店回数やお店との関係性への言及は、文の途中か最後に自然に触れる程度にする。",
  "最初の1文を、来店理由・お悩み・目的から書き始め、そのあとに施術や体験の感想を続け、最後にスタッフやお店の印象を一言添えて締める。",
  "自由記述の回答がある場合は、他の回答からではなく、必ず自由記述の内容や言い回しから最初の1〜2文を書き始める。自由記述がない場合はこの指示は無視してよい。",
  "全体を2〜3文だけの短い口コミにする。中心とする感想1つだけに絞り、来店理由・スタッフ対応・店内の様子など他の情報にはほとんど触れない（このときは複数要素を使う目安より、この指示を優先する）。",
  "最初の1文を、スタッフの対応やお店の雰囲気について触れることから書き始め、そのあとに施術や来店理由の話を続ける。",
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

// Background context only -- explicitly forbidden from being used as a
// source of new facts (see the instruction embedded in the block itself).
// description is intentionally never accepted as an input to this function
// -- it's owner-authored marketing copy, kept out of the AI's reach entirely
// so it can never leak into a "customer's" review.
function buildBackgroundBlock(salonName?: string, businessType?: string): string {
  const name = salonName?.trim();
  const type = businessType?.trim();
  if (!name && !type) return "";
  const lines = [
    "【背景情報】",
    "以下は回答の意味を正しく理解するための参考情報です。ここから新しい事実（施術内容・効果・設備・スタッフ対応など）を推測して口コミに追加することは禁止です。",
  ];
  if (name) lines.push(`店舗名: ${name}`);
  if (type) lines.push(`業種: ${type}`);
  return lines.join("\n") + "\n\n";
}

// Only present on a "regenerate" -- gives the model something concrete to
// differ from instead of relying purely on sampling randomness for variety.
// Testing showed that a vague "vary something" instruction alone still
// produced near-identical paraphrases across regenerations (same sentence
// order, synonym-level swaps only), so this is paired with promoting the
// randomly-picked structure hint from optional to mandatory -- see
// buildSystemPrompt's structureBlock branch.
function buildRegenerateBlock(previousReview?: string): string {
  const prev = previousReview?.trim();
  if (!prev) return "";
  return `【再生成時の注意】
これは同じアンケート回答からの再生成です。前回と同じ文の並び順・書き出し・締め方を繰り返さないでください。上の【構成】の指示に必ず従い、前回とはっきり異なる構成にしてください。ただし、回答に基づく事実そのものは変えないでください。

前回の文章:
${prev}

`;
}

function buildSystemPrompt(
  pattern: string,
  examples: string[],
  options: { salonName?: string; businessType?: string; previousReview?: string },
): string {
  const { salonName, businessType, previousReview } = options;
  const examplesBlock = examples.map((e, i) => `${i + 1}. ${e}`).join("\n\n");
  const backgroundBlock = buildBackgroundBlock(salonName, businessType);
  const regenerateBlock = buildRegenerateBlock(previousReview);

  return `あなたは口コミを代筆するライターではありません。

ユーザー本人が回答したアンケート内容を理解し、本人が自分の言葉でGoogle口コミを書いたかのような、自然な一つの文章に再構成する編集アシスタントです。

「選択肢を文章に変換する」だけの機械的な処理ではなく、それぞれの回答が何を意味しているかを理解したうえで、口コミ全体を組み立ててください。完成度の高い広告文章にしてはいけません。

${backgroundBlock}【回答の役割を理解する】
質問と回答をすべて同じ「感想」として並べるのではなく、それぞれが何を意味する情報かを判断してください。判断の目安は次の通りです。
・来店回数や関係性を尋ねる質問（初めて／数回目／常連など）→ 来店経験・お店との関係性
・利用したメニュー・施術・コースを尋ねる質問 → 実際に利用した内容
・来店前の悩み・希望・目的を尋ねる質問 → 来店理由（達成された結果ではない。詳しくは下記）
・好みや期待を尋ねる質問 → 本人の好み・期待
・施術後の体感やスタッフ・店内の印象を尋ねる質問 → 実際に感じた体験・評価
・自由記述 → 本人の生の言葉（最優先。詳しくは下記）
この判断は、質問文と選択肢の言葉そのものから行ってください。

【絶対に守ること】
・アンケートに回答されていない事実（施術内容、スタッフの具体的な行動、設備、商品、効果、価格など）を絶対に追加しない。
・医療的な効果を断定しない。「治った」「完治した」「絶対に効果がある」のような断定表現は使わない。本人が「〜ように感じた」と答えた範囲を超えて因果関係を強めない。
・来店前の悩み・希望・目的として選ばれた回答を、達成された結果であるかのように書き換えない（例：「疲れを取りたい」は来店理由であり、「疲れが取れた」という結果ではない。「ガッツリ食べたい」も同様に理由として扱う）。回答に結果が含まれていない場合、結果を作らない。
・ネガティブな回答が選ばれている場合、それを消して全肯定の文章に書き換えない。誇張して強調する必要もなく、自然に反映する。
・絵文字、星評価、「みなさんもぜひ」のような他者への投稿呼びかけは入れない。
・回答にない「また利用したい」「おすすめです」などの結びの感想を勝手に補って締めない（回答に再来店の意向が実際に含まれている場合のみ使ってよい）。特に回答数が少ない場合、締めの一文として「また伺いたいと思います」「また利用したいです」「またお願いしたいと思っています」のような一般的な再来店表現を無理に付け足しがちなので注意すること。そのような意向が自由記述や選択肢に明確に書かれていない限り、単に「満足しています」「良かったです」のような感想で終えてよい。

【口コミの組み立て方】
・すべての回答を1文ずつ均等に使わない。今回の口コミで一番伝えたいことを1〜2個選び、それを中心に組み立てる。他の回答は中心を自然に補強する材料として、3〜5要素程度を目安に使う（固定数ではない。回答が少なければ短くてよく、多くても不自然なら一部を使わなくてよい）。
・アンケートの質問順をそのまま文章の順番にしない。回答全体を理解したうえで、「普通の人ならどこから書くだろうか」を考えて構成する。
・選択肢の言葉をそのまま貼り付けない。意味を保ったまま、実際の口コミで使われそうな言い回しに変換する（例：「清潔感がある」→「店内もきれいで、落ち着いて過ごせました」。「スタッフが丁寧」→「スタッフさんも丁寧に対応してくれて安心できました」）。
・回答の強さ・熱量を文章に反映する。「良かった」と「絶品」「期待以上」では強さが違う。強い評価には「かなり良かった」「特に印象に残りました」のような表現を使ってよいが、弱い評価しかない場合に大げさな感動表現を勝手に加えない。
・来店回数は毎回同じ書き方にしない。初めて／数回目／常連でそれぞれ自然な表現を使い分ける（「何度か利用しています」「いつもお願いしています」など）。ただし具体的な回数が分からない場合に数字を作らない。

${
    previousReview?.trim()
      ? `【構成（前回と変える）】\n前回と同じ構成・書き出し・締め方を繰り返さないでください。次の指示に必ず従って書いてください: ${pattern}\n新しい構成にするために、回答にない感情・状況・意向（「緊張していた」「また来たい」など）を作り足してはいけません。使ってよい情報は同じ回答内容のみです。回答が少なく大きく変えようがない場合は、無理に変えず、語順や表現レベルの変化だけでも構いません。`
      : `【構成の参考（任意）】\n以下は構成の一例です。実際の回答内容に最も合う場合のみ参考にし、内容に合わなければ無視して、最も自然な構成を優先してください: ${pattern}`
  }

【文章のトーン】
自由記述がある場合は、その言葉遣い・カジュアルさ・「！」の量・文の長さ・テンションを最優先の参考にする（そのまま丸ごとコピーする必要はない）。自由記述がない場合は、選ばれた回答の強さ・種類から全体のトーン（落ち着いた／少しカジュアル／感動が強い／簡潔）を判断する。トーンを完全ランダムに決めない。

【文章の自然さ】
・短い文と説明的な長い文を自然に混ぜる。すべて同じ長さ・同じテンポに整えすぎない。
・語尾を「〜でした。〜でした。〜ました。」のように単調に繰り返さない。「〜です」「〜と感じました」「〜のも良かったです」「〜で安心」「〜だと思います」などを自然に混ぜる。ただし全部を無理に違う語尾にする必要はない。
・句読点も毎回「。」だけに揃えず、参考例のように「！」や改行を時々自然に使ってよい。
・書き出しを毎回「初めて利用しました。」「〇回目の来店でした。」のような定型文で固定しない。中心となる感想、体験、来店理由、リピーターとしての一言など、内容に合った自然な入り方を選ぶ。
・締め方も毎回「また利用したいです。」「おすすめです。」で固定しない。回答内容に応じて表現を変える（「安心して通えそうです」「今回も満足でした」など）。

【避けたいAIっぽい表現】
以下のような表現は、必要な場合を除いて毎回使わない（禁止ではないが、定型文のように多用しない）。
「とても満足しています」「安心して施術・サービスを受けることができました」「丁寧に対応していただきました」
「清潔感のある店内でした」「また利用したいと思います」「おすすめしたいお店です」
「初めての方にもおすすめです」「終始リラックスして過ごすことができました」「終始リラックスして施術を受けることができました」
「親身になって相談に乗ってくださいました」「素敵な時間を過ごすことができました」
上記は一例であり、「リラックスして〜できました」のような似た言い回し全般も同様に多用しない。

【文章量】
回答の情報量に応じて自然に変える。目安はおよそ40〜180文字程度だが、固定の下限・上限ではない。情報が少ない場合は無理に長くせず、短い口コミで問題ない。情報が多い場合も、詰め込みすぎて不自然にならないようにする。

${regenerateBlock}【参考例】
あくまで文体・自然さ・語尾や句読点の使い方の参考です。内容やエピソードはそのまま流用せず、実際の文章はアンケートの回答内容だけをもとに作成してください。

${examplesBlock}

【NG例】
「悩みが気になり来店しました。スタッフの方が親身になって相談に乗ってくださり、安心して施術を受けることができました。終わった後はとても満足しています。またぜひ利用したいと思います。」
→ 定型文が多く、質問順に並べただけのAI口コミに見える。

【出力前の最終確認（内部でのみ行い、結果や手順は出力しない）】
文章を出力する前に、次の点を自分の中で確認してください。
・質問順に並べただけになっていないか
・選択肢を言い換えずそのまま並べていないか
・回答されていない事実を作っていないか
・来店理由・目的を結果として書いていないか
・同じ語尾や同じ書き出し・締め方に固定されていないか
・宣伝文やサロン側が書いたような文章になっていないか
・実際のお客様本人が書いた口コミとして自然に読めるか
問題があれば、出力する前に書き直してください。

分類・判断・確認などの内部処理は一切出力せず、完成した口コミ本文だけを返してください。`;
}


// On sparse/ambiguous answers the model occasionally returns a meta
// response ("申し訳ありませんが、その情報からは...") instead of a review, or
// confidently hallucinates an unrelated business type (a café/restaurant
// review, since that's an extremely common review "shape" in training
// data). Neither of these should ever reach the editable textarea the
// customer sees, so we detect them and retry once with a fresh random
// pattern/example selection before giving up. Passing salonName/businessType
// (see buildBackgroundBlock) should make this less likely, but it's kept as
// a defense-in-depth backstop -- it's a narrow safety net, not a general
// fix (e.g. a massage-style review bleeding into a hair-salon answer isn't
// caught by this word list either way).
const REFUSAL_PATTERN = /^(申し訳ございません|申し訳ありません|すみません|ごめんなさい)/;
const OFF_TOPIC_PATTERN = /スイーツ|カフェ|レストラン|ランチ|ディナー|コーヒー|ケーキ|美味し|ドリンクメニュー|フードメニュー/;

function isInvalidReview(review: string): boolean {
  return REFUSAL_PATTERN.test(review) || OFF_TOPIC_PATTERN.test(review);
}

export type LegacyV1Result =
  | { ok: true; review: string; model: string; latencyMs: number; attempts: number }
  | {
      ok: false;
      status: 500 | 502 | 504;
      kind: "config" | "api_error" | "empty_response" | "invalid_review" | "timeout" | "network";
    };

/** v1 の口コミ生成(Phase 1 の前と同じプロンプト・モデル・temperature)。 */
export async function generateReviewV1(params: {
  answers: V1Answer[];
  salonName?: string;
  businessType?: string;
  previousReview?: string;
}): Promise<LegacyV1Result> {
  const { answers, salonName, businessType, previousReview } = params;

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) {
    console.error("Missing OPENAI_API_KEY or OPENAI_MODEL env var");
    return { ok: false, status: 500, kind: "config" };
  }

  const startedAt = Date.now();
  const userMessage = answers
    .map(({ question, answer }) => {
      const answerText = Array.isArray(answer) ? answer.join("、") : answer;
      return answerText ? `${question}: ${answerText}` : null;
    })
    .filter(Boolean)
    .join("\n");

  const generate = async (): Promise<{ review: string } | { failure: LegacyV1Result }> => {
    const pattern =
      STRUCTURE_HINTS[Math.floor(Math.random() * STRUCTURE_HINTS.length)];
    const examples = pickRandomExamples(REVIEW_EXAMPLES, EXAMPLES_PER_PROMPT);
    const systemPrompt = buildSystemPrompt(pattern, examples, {
      salonName,
      businessType,
      previousReview,
    });

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
      console.error("OpenAI API error (v1)", { status: openaiRes.status });
      return { failure: { ok: false, status: 502, kind: "api_error" } };
    }

    const data = await openaiRes.json();
    const review = data?.choices?.[0]?.message?.content?.trim();
    if (!review) {
      console.error("OpenAI response missing review content (v1)");
      return { failure: { ok: false, status: 502, kind: "empty_response" } };
    }

    return { review };
  };

  try {
    let attempts = 1;
    let result = await generate();

    if ("review" in result && isInvalidReview(result.review)) {
      console.warn("OpenAI returned a refusal-like or off-topic response, retrying once (v1)");
      attempts = 2;
      result = await generate();
    }

    if ("failure" in result) return result.failure;
    if (isInvalidReview(result.review)) {
      console.error("OpenAI kept returning a refusal-like or off-topic response (v1)");
      return { ok: false, status: 502, kind: "invalid_review" };
    }

    return { ok: true, review: result.review, model, latencyMs: Date.now() - startedAt, attempts };
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    console.error("Failed to call OpenAI API (v1)", { kind: timeout ? "timeout" : "network" });
    return { ok: false, status: timeout ? 504 : 502, kind: timeout ? "timeout" : "network" };
  }
}
