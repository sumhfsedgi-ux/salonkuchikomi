import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadActiveSurvey,
  parseGenerateRequest,
  validateAnswers,
  type ActiveSurvey,
} from "@/lib/reviewGeneration/validateAnswers";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const Q_VISIT = "22222222-2222-4222-8222-222222222222";
const Q_STAFF = "33333333-3333-4333-8333-333333333333";
const Q_FREE = "44444444-4444-4444-8444-444444444444";
const UNKNOWN = "55555555-5555-4555-8555-555555555555";

const SURVEY: ActiveSurvey = {
  salonId: SALON_ID,
  salonName: "テストサロン",
  businessType: "エステ",
  description: null,
  questions: [
    { id: Q_VISIT, text: "今回のご来店は何回目ですか？", type: "single", options: ["初めて", "2〜3回目"], maxSelections: null },
    {
      id: Q_STAFF,
      text: "スタッフ・サロンについて感じたことを教えてください",
      type: "multiple",
      options: ["説明が分かりやすかった", "落ち着いた雰囲気", "その他"],
      maxSelections: 2,
    },
    { id: Q_FREE, text: "ご自由にお書きください", type: "text", options: [], maxSelections: null },
  ],
};

describe("parseGenerateRequest", () => {
  it("新しい形式を読む", () => {
    const request = parseGenerateRequest({
      salonId: SALON_ID,
      answers: [{ questionId: Q_VISIT, values: ["初めて"] }],
      previousPlan: { length: "short", emotion: "none", exclamation: "occasional", opening: "fact", closing: "neutral", tone: "plain" },
    });
    expect(request).toMatchObject({ salonId: SALON_ID, legacy: false, previousPlan: { opening: "fact" } });
  });

  it("開いたままの古いページが前の形式(構成プラン)を送ってきても、エラーにせず無視する", () => {
    const request = parseGenerateRequest({
      salonId: SALON_ID,
      answers: [{ questionId: Q_VISIT, values: ["初めて"] }],
      previousPlan: { mainIds: ["M1"], supportIds: [], length: "short", opening: "main", closing: "plain" },
    });
    expect(request).toMatchObject({ salonId: SALON_ID, legacy: false });
    expect(request?.previousPlan).toBeUndefined();
  });

  it("旧形式(質問文と回答の文字列)も読み、「その他（詳細）」を分ける", () => {
    const request = parseGenerateRequest({
      salonId: SALON_ID,
      salonName: "使わない",
      answers: [
        { question: "スタッフ・サロンについて感じたことを教えてください", answer: ["落ち着いた雰囲気", "その他（照明が暗め）"] },
        { question: "ご自由にお書きください", answer: "" },
      ],
    });
    expect(request?.legacy).toBe(true);
    expect(request?.answers).toEqual([
      { question: "スタッフ・サロンについて感じたことを教えてください", values: ["落ち着いた雰囲気", "その他"], otherDetail: "照明が暗め" },
      { question: "ご自由にお書きください", values: [], otherDetail: undefined },
    ]);
  });

  it("形式が不正なら null", () => {
    expect(parseGenerateRequest({ salonId: "not-a-uuid", answers: [] })).toBeNull();
    expect(parseGenerateRequest({ salonId: SALON_ID, answers: [{ questionId: Q_VISIT, values: "初めて" }] })).toBeNull();
    expect(parseGenerateRequest(null)).toBeNull();
  });
});

describe("validateAnswers", () => {
  it("DB の質問文・質問の順で素材の入力と v1 用の回答を作る", () => {
    const result = validateAnswers(SURVEY, [
      { questionId: Q_FREE, values: ["待ち時間が長かった"] },
      { questionId: Q_STAFF, values: ["落ち着いた雰囲気", "その他"], otherDetail: "照明が暗め" },
      { questionId: Q_VISIT, values: ["初めて"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputs).toEqual([
      { questionText: "今回のご来店は何回目ですか？", questionType: "single", selected: ["初めて"], otherDetail: undefined },
      {
        questionText: "スタッフ・サロンについて感じたことを教えてください",
        questionType: "multiple",
        selected: ["落ち着いた雰囲気", "その他"],
        otherDetail: "照明が暗め",
      },
      { questionText: "ご自由にお書きください", questionType: "text", selected: [], freeText: "待ち時間が長かった" },
    ]);
    expect(result.v1Answers).toEqual([
      { question: "今回のご来店は何回目ですか？", answer: "初めて" },
      { question: "スタッフ・サロンについて感じたことを教えてください", answer: ["落ち着いた雰囲気", "その他（照明が暗め）"] },
      { question: "ご自由にお書きください", answer: "待ち時間が長かった" },
    ]);
  });

  it("ID が変わっていたら質問文で照合する", () => {
    const result = validateAnswers(SURVEY, [{ questionId: UNKNOWN, question: "今回のご来店は何回目ですか？", values: ["初めて"] }]);
    expect(result.ok).toBe(true);
  });

  it("照合できない回答・選択肢に無い値は stale(ページの再読み込みを案内する)", () => {
    expect(validateAnswers(SURVEY, [{ questionId: UNKNOWN, question: "消えた質問", values: ["はい"] }])).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(validateAnswers(SURVEY, [{ questionId: Q_VISIT, values: ["5回目"] }])).toEqual({ ok: false, reason: "stale" });
  });

  it("選択肢の前後に空白があっても照合できる", () => {
    const survey: ActiveSurvey = {
      ...SURVEY,
      questions: [{ ...SURVEY.questions[0], options: ["初めて ", " 2〜3回目"] }],
    };
    expect(validateAnswers(survey, [{ questionId: Q_VISIT, values: ["初めて "] }]).ok).toBe(true);
    expect(validateAnswers(survey, [{ questionId: Q_VISIT, values: ["2〜3回目"] }]).ok).toBe(true);
  });

  it("もう無い質問への空の回答は無視する", () => {
    const result = validateAnswers(SURVEY, [
      { questionId: UNKNOWN, question: "消えた質問", values: [] },
      { questionId: Q_VISIT, values: ["初めて"] },
    ]);
    expect(result.ok).toBe(true);
  });

  it("上限を超える選択・同じ質問への重複回答は invalid", () => {
    expect(
      validateAnswers(SURVEY, [{ questionId: Q_STAFF, values: ["説明が分かりやすかった", "落ち着いた雰囲気", "その他"] }]),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(validateAnswers(SURVEY, [{ questionId: Q_VISIT, values: ["初めて", "2〜3回目"] }])).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      validateAnswers(SURVEY, [
        { questionId: Q_VISIT, values: ["初めて"] },
        { questionId: UNKNOWN, question: "今回のご来店は何回目ですか？", values: ["初めて"] },
      ]),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("「その他」を選んでいなければ詳細は使わない", () => {
    const result = validateAnswers(SURVEY, [{ questionId: Q_STAFF, values: ["落ち着いた雰囲気"], otherDetail: "使わない" }]);
    expect(result.ok && result.inputs[0].otherDetail).toBeUndefined();
  });

  it("回答が1つも無ければ empty", () => {
    expect(validateAnswers(SURVEY, [{ questionId: Q_FREE, values: ["   "] }])).toEqual({ ok: false, reason: "empty" });
  });
});

// loadActiveSurvey 用の、テーブルごとに結果を返す最小限の偽クライアント。
function fakeSupabase(tables: Record<string, { data: unknown; error?: unknown }>) {
  const filters: Array<[string, string, unknown]> = [];
  const from = (table: string) => {
    const result = tables[table] ?? { data: null };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([table, column, value]);
        return builder;
      },
      in: (column: string, value: unknown) => {
        filters.push([table, column, value]);
        return builder;
      },
      order: () => builder,
      maybeSingle: async () => ({ data: result.data, error: result.error ?? null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: result.data, error: result.error ?? null }),
    };
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, filters };
}

describe("loadActiveSurvey", () => {
  it("店舗・有効なアンケート・質問・選択肢を読む", async () => {
    const { client, filters } = fakeSupabase({
      salon_public: { data: { id: SALON_ID, name: "テストサロン", business_type: null, description: "丁寧なご説明を大切にしています" } },
      // 質問と選択肢は、アンケートに埋め込んで1回で読む。
      surveys: {
        data: {
          id: "survey-1",
          questions: [
            {
              id: Q_VISIT,
              question_text: "何回目？",
              question_type: "single",
              max_selections: null,
              question_options: [{ option_text: "初めて" }],
            },
          ],
        },
      },
    });
    const survey = await loadActiveSurvey(client, SALON_ID);
    expect(survey).toEqual({
      salonId: SALON_ID,
      salonName: "テストサロン",
      businessType: null,
      description: "丁寧なご説明を大切にしています",
      questions: [{ id: Q_VISIT, text: "何回目？", type: "single", options: ["初めて"], maxSelections: null }],
    });
    expect(filters).toContainEqual(["surveys", "is_active", true]);
    expect(filters).toContainEqual(["surveys", "salon_id", SALON_ID]);
  });

  it("店舗が無ければ null、DB のエラーは投げる", async () => {
    expect(await loadActiveSurvey(fakeSupabase({ salon_public: { data: null } }).client, SALON_ID)).toBeNull();
    await expect(
      loadActiveSurvey(fakeSupabase({ salon_public: { data: null, error: new Error("db") } }).client, SALON_ID),
    ).rejects.toThrow("db");
  });
});
