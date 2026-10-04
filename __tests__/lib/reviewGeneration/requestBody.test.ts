import { describe, expect, it } from "vitest";
import { buildGenerateRequestBody } from "@/lib/reviewGeneration/requestBody";
import { parseGenerateRequest } from "@/lib/reviewGeneration/validateAnswers";
import type { SurveyQuestion } from "@/lib/types";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const QUESTIONS: SurveyQuestion[] = [
  { id: "22222222-2222-4222-8222-222222222222", question: "何回目？", required: true, sortOrder: 1, type: "single", options: ["初めて", "その他"] },
  {
    id: "33333333-3333-4333-8333-333333333333",
    question: "スタッフについて",
    required: true,
    sortOrder: 2,
    type: "multiple",
    options: ["丁寧", "その他"],
    maxSelections: 3,
  },
  { id: "44444444-4444-4444-8444-444444444444", question: "ご自由に", required: false, sortOrder: 3, type: "text", maxLength: 300 },
];

describe("buildGenerateRequestBody", () => {
  it("質問IDと選んだ値を送り、「その他」の詳細はその他を選んだときだけ付ける", () => {
    const body = buildGenerateRequestBody({
      salonId: SALON_ID,
      questions: QUESTIONS,
      answers: {
        [QUESTIONS[0].id]: "初めて",
        [QUESTIONS[1].id]: ["丁寧", "その他"],
        [QUESTIONS[2].id]: "",
      },
      otherDetails: { [QUESTIONS[0].id]: "使わない", [QUESTIONS[1].id]: " 声が小さめ " },
    });
    expect(body).toEqual({
      salonId: SALON_ID,
      answers: [
        { questionId: QUESTIONS[0].id, question: "何回目？", values: ["初めて"], otherDetail: undefined },
        { questionId: QUESTIONS[1].id, question: "スタッフについて", values: ["丁寧", "その他"], otherDetail: "声が小さめ" },
        { questionId: QUESTIONS[2].id, question: "ご自由に", values: [], otherDetail: undefined },
      ],
      previousReview: undefined,
      previousPlan: undefined,
    });
  });

  it("サーバーが新しい形式として読める(再生成の情報も含めて)", () => {
    const body = buildGenerateRequestBody({
      salonId: SALON_ID,
      questions: QUESTIONS,
      answers: { [QUESTIONS[0].id]: "初めて" },
      otherDetails: {},
      previousReview: "前回の下書き",
      previousPlan: { length: "short", emotion: "none", exclamation: "occasional", opening: "fact", closing: "neutral", tone: "plain" },
    });
    const parsed = parseGenerateRequest(JSON.parse(JSON.stringify(body)));
    expect(parsed?.legacy).toBe(false);
    expect(parsed?.previousPlan?.opening).toBe("fact");
    expect(parsed?.previousReview).toBe("前回の下書き");
  });
});
