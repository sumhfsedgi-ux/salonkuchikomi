import { describe, expect, it } from "vitest";
import type { CallOpenAIJsonOptions, OpenAITask } from "@/lib/ai/openai";
import { buildMaterials } from "@/lib/reviewGeneration/materials";
import { runReviewPipeline, type PipelineInput } from "@/lib/reviewGeneration/pipeline";
import type { RawDraft, RawVerification } from "@/lib/reviewGeneration/prompts";
import { loadActiveSurvey, validateAnswers, type ActiveSurvey, type RawAnswer } from "@/lib/reviewGeneration/validateAnswers";
import type { CallJson } from "@/lib/reviewGeneration/verify";
import { fakeSurveyDb, type FakeTables } from "./fakeSurveyDb";
import { legacyLoadActiveSurvey } from "./legacyLoadActiveSurvey";

const SALON = "11111111-1111-4111-8111-111111111111";
const SALON_NO_SURVEY = "22222222-2222-4222-8222-222222222222";
const SALON_EMPTY_SURVEY = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_SALON = "44444444-4444-4444-8444-444444444444";
const Q = {
  visit: "aaaaaaaa-0000-4000-8000-000000000001",
  feeling: "aaaaaaaa-0000-4000-8000-000000000002",
  staff: "aaaaaaaa-0000-4000-8000-000000000003",
  free: "aaaaaaaa-0000-4000-8000-000000000004",
  inactive: "aaaaaaaa-0000-4000-8000-000000000005",
};

/** 質問も選択肢も、sort_order とは違う順で入れておく(並べ方を指定し忘れたら気づける)。 */
function tables(): FakeTables {
  return {
    salon_public: [
      { id: SALON, name: "架空のサロン", business_type: "エステ・フェイシャル", description: "肌の状態に合わせた説明を大切にしています。" },
      { id: SALON_NO_SURVEY, name: "アンケートの無いサロン", business_type: null, description: null },
      { id: SALON_EMPTY_SURVEY, name: "質問の無いサロン", business_type: "美容室", description: null },
    ],
    surveys: [
      { id: "s-inactive", salon_id: SALON, is_active: false },
      { id: "s-active", salon_id: SALON, is_active: true },
      { id: "s-old", salon_id: SALON_NO_SURVEY, is_active: false },
      { id: "s-empty", salon_id: SALON_EMPTY_SURVEY, is_active: true },
    ],
    questions: [
      { id: Q.staff, survey_id: "s-active", question_text: "スタッフ・サロンについて感じたことを教えてください", question_type: "multiple", max_selections: 3, sort_order: 3 },
      { id: Q.visit, survey_id: "s-active", question_text: "今回のご来店は何回目ですか？", question_type: "single", max_selections: null, sort_order: 1 },
      { id: Q.free, survey_id: "s-active", question_text: "ご自由にお書きください", question_type: "text", max_selections: null, sort_order: 4 },
      { id: Q.feeling, survey_id: "s-active", question_text: "施術後のお肌について、どのように感じましたか？", question_type: "multiple", max_selections: 3, sort_order: 2 },
      { id: Q.inactive, survey_id: "s-inactive", question_text: "古い質問", question_type: "single", max_selections: null, sort_order: 1 },
    ],
    question_options: [
      { question_id: Q.feeling, option_text: "その他", sort_order: 3 },
      { question_id: Q.visit, option_text: "3回目以上", sort_order: 3 },
      { question_id: Q.staff, option_text: "清潔感がある", sort_order: 2 },
      { question_id: Q.visit, option_text: "初めて", sort_order: 1 },
      { question_id: Q.feeling, option_text: "肌がつるっとした", sort_order: 1 },
      { question_id: Q.staff, option_text: "説明が分かりやすかった", sort_order: 1 },
      { question_id: Q.visit, option_text: "2回目", sort_order: 2 },
      { question_id: Q.feeling, option_text: "肌がなめらかになったように感じた", sort_order: 2 },
      { question_id: Q.inactive, option_text: "古い選択肢", sort_order: 1 },
    ],
  };
}

async function both(salonId: string, data = tables(), errors?: Parameters<typeof fakeSurveyDb>[1]) {
  const before = fakeSurveyDb(data, errors);
  const after = fakeSurveyDb(data, errors);
  const settle = (p: Promise<ActiveSurvey | null>) => p.then((value) => ({ value }), (error: unknown) => ({ error }));
  return {
    legacy: await settle(legacyLoadActiveSurvey(before.client, salonId)),
    current: await settle(loadActiveSurvey(after.client, salonId)),
    legacyStats: before.stats(),
    currentStats: after.stats(),
  };
}

describe("loadActiveSurvey: 変更前と同じ結果", () => {
  it("有効なアンケートの質問と選択肢を、どちらも sort_order の順で返す(無効なアンケートは使わない)", async () => {
    const { legacy, current } = await both(SALON);
    expect(current).toEqual(legacy);
    const survey = (current as { value: ActiveSurvey }).value;
    expect(survey.questions.map((q) => q.text)).toEqual([
      "今回のご来店は何回目ですか？",
      "施術後のお肌について、どのように感じましたか？",
      "スタッフ・サロンについて感じたことを教えてください",
      "ご自由にお書きください",
    ]);
    expect(survey.questions[0].options).toEqual(["初めて", "2回目", "3回目以上"]);
    expect(survey.questions[3].options).toEqual([]);
    expect(survey.description).toBe("肌の状態に合わせた説明を大切にしています。");
  });

  it.each([
    ["店舗が無い", UNKNOWN_SALON],
    ["有効なアンケートが無い", SALON_NO_SURVEY],
  ])("%s ときは null", async (_label, salonId) => {
    const { legacy, current } = await both(salonId);
    expect(legacy).toEqual({ value: null });
    expect(current).toEqual({ value: null });
  });

  it("質問が0件なら、質問の無いアンケートを返す", async () => {
    const { legacy, current } = await both(SALON_EMPTY_SURVEY);
    expect(current).toEqual(legacy);
    expect((current as { value: ActiveSurvey }).value.questions).toEqual([]);
  });

  it("店舗のエラーは、アンケートのエラーより先に投げる", async () => {
    const salonError = { message: "salon failed", code: "XX001" };
    const { legacy, current } = await both(SALON, tables(), { salon_public: salonError, surveys: { message: "survey failed", code: "XX002" } });
    expect(legacy).toEqual({ error: salonError });
    expect(current).toEqual({ error: salonError });
  });

  it("店舗が無ければ、アンケートのエラーがあっても null(変更前と同じ)", async () => {
    const { legacy, current } = await both(UNKNOWN_SALON, tables(), { surveys: { message: "survey failed", code: "XX002" } });
    expect(legacy).toEqual({ value: null });
    expect(current).toEqual({ value: null });
  });

  it("店舗があってアンケートの読み取りに失敗したら、そのエラーを投げる", async () => {
    const surveyError = { message: "survey failed", code: "XX002" };
    const { legacy, current } = await both(SALON, tables(), { surveys: surveyError });
    expect(legacy).toEqual({ error: surveyError });
    expect(current).toEqual({ error: surveyError });
  });

  it("有効なアンケートが2件あれば、変更前と同じくエラーにする", async () => {
    const data = tables();
    data.surveys.push({ id: "s-dup", salon_id: SALON, is_active: true });
    const { legacy, current } = await both(SALON, data);
    expect(legacy).toEqual({ error: expect.objectContaining({ code: "PGRST116" }) });
    expect(current).toEqual({ error: expect.objectContaining({ code: "PGRST116" }) });
  });

  it("DB への問い合わせは4回の順番から、同時の2回になる", async () => {
    const { legacyStats, currentStats } = await both(SALON);
    expect(legacyStats).toEqual({ maxInFlight: 1, requests: ["salon_public", "surveys", "questions", "question_options"] });
    expect(currentStats.requests).toHaveLength(2);
    expect(currentStats.maxInFlight).toBe(2);
  });
});

// ── 品質が変わらないことの確認: 同じ回答から AI に渡る内容・条件が、変更の前後で完全に一致する ──

type Handler = unknown;

/** タスクごとに返す値を順に並べた偽の AI 呼び出し。渡された引数はすべて記録する。 */
function fakeAI(script: Partial<Record<OpenAITask, Handler[]>>) {
  const calls: CallOpenAIJsonOptions[] = [];
  const queues = Object.fromEntries(Object.entries(script).map(([task, list]) => [task, [...(list ?? [])]]));
  const callJson: CallJson = async <T>(options: CallOpenAIJsonOptions) => {
    calls.push(structuredClone(options));
    const next = queues[options.task]?.shift();
    if (next === undefined) throw new Error(`予定外の呼び出し: ${options.task}`);
    return { data: structuredClone(next) as T, model: `model-${options.task}`, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1, attempts: 1 };
  };
  return { callJson, calls };
}

/** 同じ種から同じ並びを返す乱数(毎回作り直して、前後で同じ乱数の条件にする)。 */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const draft = (...sentences: Array<[string, string[]]>): RawDraft => ({
  sentences: sentences.map(([text, source_ids]) => ({ text, source_ids, break_after: false })),
});
const verdicts = (...rows: Array<[number, boolean, string[]?]>): RawVerification => ({
  results: rows.map(([sentence, supported, issues]) => ({
    sentence,
    supported,
    issues: (issues ?? []) as RawVerification["results"][number]["issues"],
  })),
});

const POSITIVE_ANSWERS: RawAnswer[] = [
  { questionId: Q.visit, values: ["初めて"] },
  { questionId: Q.feeling, values: ["肌がなめらかになったように感じた"] },
  { questionId: Q.staff, values: ["説明が分かりやすかった"] },
];
const WITH_NEGATIVE: RawAnswer[] = [...POSITIVE_ANSWERS, { questionId: Q.free, values: ["待ち時間が長かったのが残念でした。"] }];

const SCENARIOS: Array<{
  name: string;
  answers: RawAnswer[];
  script: Partial<Record<OpenAITask, Handler[]>>;
  previousSeed?: PipelineInput["previousSeed"];
  tasks: OpenAITask[];
}> = [
  {
    name: "初回の生成(1回で終わる)",
    answers: POSITIVE_ANSWERS,
    script: { review_generation: [draft(["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]], ["肌がなめらかになったように感じました。", ["M2"]])] },
    tasks: ["review_generation"],
  },
  {
    name: "再生成(前回の文体の傾向を渡す)",
    answers: POSITIVE_ANSWERS,
    previousSeed: { length: "short", emotion: "low", exclamation: "none", opening: "fact", closing: "none_preferred", tone: "plain" },
    script: { review_generation: [draft(["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]], ["肌がなめらかになったように感じました。", ["M2"]])] },
    tasks: ["review_generation"],
  },
  {
    name: "使える文が無く作り直し、抜けた良さを修正で補う",
    answers: POSITIVE_ANSWERS,
    script: {
      review_generation: [draft(["仕事帰りに寄りました。", ["M1"]]), draft(["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]])],
      review_repair: [draft(["初めてでしたが、説明が分かりやすかったです。", ["M1", "M3"]], ["肌がなめらかになったように感じました。", ["M2"]])],
    },
    tasks: ["review_generation", "review_generation", "review_repair"],
  },
  {
    name: "構成の問題で全文を作り直す",
    answers: POSITIVE_ANSWERS,
    script: {
      review_generation: [
        draft(["初めてでした。", ["M1"]], ["肌がなめらかになったように感じた。", ["M2"]], ["説明が分かりやすかった。", ["M3"]]),
        draft(["説明が分かりやすくて、肌もなめらかになったように感じました。", ["M2", "M3"]]),
      ],
    },
    tasks: ["review_generation", "review_generation"],
  },
  {
    name: "意味の検証に進む",
    answers: WITH_NEGATIVE,
    script: {
      review_generation: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間が長かったのは残念でした。", ["M4"]], ["肌がなめらかになったように感じました。", ["M2"]])],
      review_verification: [verdicts([1, true])],
    },
    tasks: ["review_generation", "review_verification"],
  },
  {
    name: "修正と再検証に進む",
    answers: WITH_NEGATIVE,
    script: {
      review_generation: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間も気にならなかったです。", ["M4"]])],
      review_verification: [verdicts([1, false, ["polarity_flip"]]), verdicts([1, true])],
      review_repair: [draft(["説明が分かりやすかったです。", ["M3"]], ["待ち時間が長かったのは残念でした。", ["M4"]])],
    },
    tasks: ["review_generation", "review_verification", "review_repair", "review_verification"],
  },
];

async function runWith(survey: ActiveSurvey, scenario: (typeof SCENARIOS)[number]) {
  const validation = validateAnswers(survey, scenario.answers);
  if (!validation.ok) throw new Error(`回答の照合に失敗: ${validation.reason}`);
  const ai = fakeAI(scenario.script);
  const result = await runReviewPipeline(
    {
      materials: buildMaterials(validation.inputs),
      businessType: survey.businessType,
      storeDescription: survey.description,
      previousSeed: scenario.previousSeed,
    },
    { callJson: ai.callJson, random: seededRandom(20261010), now: () => 0, resolveModel: () => "gpt-4.1-mini" },
  );
  return { inputs: validation.inputs, calls: ai.calls, result };
}

describe("品質の一致: 変更前と変更後の読み取り結果から、AI に同じ内容・条件が渡る", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const legacySurvey = await legacyLoadActiveSurvey(fakeSurveyDb(tables()).client, SALON);
    const currentSurvey = await loadActiveSurvey(fakeSurveyDb(tables()).client, SALON);
    if (!legacySurvey || !currentSurvey) throw new Error("アンケートが読めない");

    const before = await runWith(legacySurvey, scenario);
    const after = await runWith(currentSurvey, scenario);

    expect(after.calls.map((c) => c.task)).toEqual(scenario.tasks);
    // メッセージ・モデルの指定・スキーマ・温度・出力の上限・タイムアウトを含む、呼び出しの引数すべて。
    expect(after.calls).toEqual(before.calls);
    expect(after.inputs).toEqual(before.inputs);
    expect(after.result).toEqual(before.result);
  });
});
