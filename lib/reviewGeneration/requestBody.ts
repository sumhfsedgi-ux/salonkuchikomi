// お客様ページ(ReviewFlow)から /api/generate-review へ送るリクエストの組み立て。
// クライアントからも読み込むので、サーバー専用のモジュールは import しない。
//
// 質問文は ID で照合できなかったときの予備としてだけ送る(サーバーはプロンプトに
// DB の質問文を使う)。前回のプランは素材の本文を含まない(v2 の再生成用)。
// 前回の文章は v1 の再生成用で、v1 を使っている間だけ意味がある。

import { OTHER_OPTION_TEXT } from "@/lib/constants";
import type { SurveyAnswers, SurveyQuestion } from "@/lib/types";
import type { PreviousPlan } from "@/lib/reviewGeneration/plan";

export interface GenerateRequestBody {
  salonId: string;
  answers: Array<{ questionId: string; question: string; values: string[]; otherDetail?: string }>;
  previousReview?: string;
  previousPlan?: PreviousPlan;
}

export function buildGenerateRequestBody(params: {
  salonId: string;
  questions: readonly SurveyQuestion[];
  answers: SurveyAnswers;
  otherDetails: Record<string, string>;
  previousReview?: string;
  previousPlan?: PreviousPlan | null;
}): GenerateRequestBody {
  return {
    salonId: params.salonId,
    answers: params.questions.map((question) => {
      const raw = params.answers[question.id];
      const values = Array.isArray(raw) ? [...raw] : raw ? [raw] : [];
      const detail = params.otherDetails[question.id]?.trim();
      const otherDetail = detail && values.includes(OTHER_OPTION_TEXT) ? detail : undefined;
      return { questionId: question.id, question: question.question, values, otherDetail };
    }),
    previousReview: params.previousReview || undefined,
    previousPlan: params.previousPlan ?? undefined,
  };
}
