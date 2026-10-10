// /api/generate-review のリクエストを読み、回答を DB のアンケートと照合する
// (docs/plans/reviews-465-plan.md §13-2 ①)。
//
// 質問文・選択肢の文言はクライアントの値を使わず、DB のものを使う(プロンプトに
// 入るのは DB の文言だけ)。質問IDはオーナーがアンケートを保存するたびに変わる
// (0007 save_survey_questions)ため、ID で見つからなければ質問文で照合する。
// それでも照合できない回答は「アンケートが更新された」として扱う(409)。

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OTHER_DETAIL_MAX_LENGTH, OTHER_OPTION_TEXT, TEXT_ANSWER_MAX_LENGTH } from "@/lib/constants";
import type { MaterialInput } from "@/lib/reviewGeneration/materials";
import { previousStyleSeedSchema, type PreviousStyleSeed } from "@/lib/reviewGeneration/plan";

// 複数選択の上限が DB に無いときの既定値(お客様ページと同じ)。
const DEFAULT_MAX_SELECTIONS = 3;

const answerSchema = z.object({
  questionId: z.string().uuid(),
  /** 照合の予備(ID が変わっていた場合だけ使う)。プロンプトには使わない。 */
  question: z.string().max(200).optional(),
  values: z.array(z.string().max(TEXT_ANSWER_MAX_LENGTH)).max(10),
  otherDetail: z.string().max(OTHER_DETAIL_MAX_LENGTH).optional(),
});

const requestSchema = z.object({
  salonId: z.string().uuid(),
  answers: z.array(answerSchema).max(20),
  /** v1 の再生成用(v1 を使っている間だけ)。 */
  previousReview: z.string().trim().max(1000).optional(),
  /**
   * v2 の再生成用の前回の Style Seed(素材の本文は含まない)。開いたままの古いページが前の形式
   * (構成プラン)を送ってきても、エラーにせず無視する。
   */
  previousPlan: previousStyleSeedSchema.optional().catch(undefined),
});

// このリリースより前のお客様ページが送る形式。開いたままのページのために、
// 1リリースの間だけ受け付ける。salonName / businessType は使わず DB の値を使う。
const legacyRequestSchema = z.object({
  salonId: z.string().uuid(),
  answers: z
    .array(
      z.object({
        question: z.string().max(200),
        answer: z.union([
          z.string().max(TEXT_ANSWER_MAX_LENGTH),
          z.array(z.string().max(TEXT_ANSWER_MAX_LENGTH)).max(10),
        ]),
      }),
    )
    .max(20),
  salonName: z.string().trim().max(100).optional(),
  businessType: z.string().trim().max(100).optional(),
  previousReview: z.string().trim().max(1000).optional(),
});

export interface RawAnswer {
  questionId?: string;
  question?: string;
  values: string[];
  otherDetail?: string;
}

export interface GenerateRequest {
  salonId: string;
  answers: RawAnswer[];
  previousReview?: string;
  previousPlan?: PreviousStyleSeed;
  legacy: boolean;
}

// 旧形式の「その他（詳細）」を、選択肢「その他」と詳細に分ける。
const LEGACY_OTHER_PATTERN = new RegExp(`^${OTHER_OPTION_TEXT}（(.*)）$`, "su");

function fromLegacyAnswer(answer: { question: string; answer: string | string[] }): RawAnswer {
  const values = (Array.isArray(answer.answer) ? answer.answer : [answer.answer]).filter((v) => v !== "");
  let otherDetail: string | undefined;
  const normalized = values.map((value) => {
    const match = LEGACY_OTHER_PATTERN.exec(value);
    if (!match) return value;
    otherDetail = match[1].slice(0, OTHER_DETAIL_MAX_LENGTH);
    return OTHER_OPTION_TEXT;
  });
  return { question: answer.question, values: normalized, otherDetail };
}

/** リクエストを読む。形式が不正なら null。 */
export function parseGenerateRequest(body: unknown): GenerateRequest | null {
  const current = requestSchema.safeParse(body);
  if (current.success) {
    const { salonId, answers, previousReview, previousPlan } = current.data;
    return { salonId, answers, previousReview, previousPlan, legacy: false };
  }
  const legacy = legacyRequestSchema.safeParse(body);
  if (legacy.success) {
    const { salonId, answers, previousReview } = legacy.data;
    return { salonId, answers: answers.map(fromLegacyAnswer), previousReview, legacy: true };
  }
  return null;
}

export interface SurveyQuestionRecord {
  id: string;
  text: string;
  type: "single" | "multiple" | "text";
  options: string[];
  maxSelections: number | null;
}

export interface ActiveSurvey {
  salonId: string;
  salonName: string;
  businessType: string | null;
  /** オーナーが登録した店舗の説明(お客様の体験ではない。Appeal Planning の優先度付けにだけ使う)。 */
  description: string | null;
  questions: SurveyQuestionRecord[];
}

interface SurveyRow {
  id: string;
  questions:
    | {
        id: string;
        question_text: string;
        question_type: "single" | "multiple" | "text";
        max_selections: number | null;
        question_options: { option_text: string }[] | null;
      }[]
    | null;
}

/**
 * 店舗の有効なアンケートを読む(anon で読める範囲: salon_public ビューと公開中のアンケート)。
 * 店舗かアンケートが無ければ null。DB のエラーは投げる。
 *
 * 店舗(salon_public はビューなので埋め込めない)と、アンケート(質問・選択肢を埋め込み)は
 * 互いに依存しないので、同時に読む(DB の往復は1回分)。並べ方は今までと同じく、質問も選択肢も
 * sort_order の順。エラーと「無い」の判定は、今までと同じく店舗 → アンケートの順に見る。
 */
export async function loadActiveSurvey(supabase: SupabaseClient, salonId: string): Promise<ActiveSurvey | null> {
  const [salonResult, surveyResult] = await Promise.all([
    supabase.from("salon_public").select("id, name, business_type, description").eq("id", salonId).maybeSingle(),
    supabase
      .from("surveys")
      .select("id, questions(id, question_text, question_type, max_selections, question_options(option_text))")
      .eq("salon_id", salonId)
      .eq("is_active", true)
      .order("sort_order", { referencedTable: "questions" })
      .order("sort_order", { referencedTable: "questions.question_options" })
      .maybeSingle(),
  ]);

  const { data: salon, error: salonError } = salonResult;
  if (salonError) throw salonError;
  if (!salon) return null;

  const { error: surveyError } = surveyResult;
  const survey = surveyResult.data as SurveyRow | null;
  if (surveyError) throw surveyError;
  if (!survey) return null;

  return {
    salonId: salon.id as string,
    salonName: salon.name as string,
    businessType: (salon.business_type as string | null) ?? null,
    description: (salon.description as string | null) ?? null,
    questions: (survey.questions ?? []).map((q) => ({
      id: q.id,
      text: q.question_text,
      type: q.question_type,
      options: (q.question_options ?? []).map((o) => o.option_text),
      maxSelections: q.max_selections,
    })),
  };
}

/** v1 のプロンプト用の回答(今までのお客様ページが送っていた形)。 */
export interface V1Answer {
  question: string;
  answer: string | string[];
}

export type ValidationResult =
  | { ok: true; inputs: MaterialInput[]; v1Answers: V1Answer[] }
  | { ok: false; reason: "stale" | "invalid" | "empty" };

/** 回答を DB のアンケートと照合する。結果は DB の質問の順に並べる。 */
export function validateAnswers(survey: ActiveSurvey, answers: readonly RawAnswer[]): ValidationResult {
  const byId = new Map(survey.questions.map((q) => [q.id, q]));
  const byText = new Map(survey.questions.map((q) => [q.text.trim(), q]));
  const matched = new Map<string, { question: SurveyQuestionRecord; values: string[]; otherDetail?: string }>();

  for (const answer of answers) {
    const values = [...new Set(answer.values.map((v) => v.trim()).filter((v) => v !== ""))];
    const question =
      (answer.questionId ? byId.get(answer.questionId) : undefined) ??
      (answer.question ? byText.get(answer.question.trim()) : undefined);

    if (!question) {
      // 古いページの、もう無い質問への空の回答は無視する。答えてあれば照合できない。
      if (values.length === 0) continue;
      return { ok: false, reason: "stale" };
    }
    if (matched.has(question.id)) return { ok: false, reason: "invalid" };
    if (values.length === 0) continue;

    if (question.type === "text") {
      if (values.length > 1) return { ok: false, reason: "invalid" };
    } else {
      const max = question.type === "single" ? 1 : (question.maxSelections ?? DEFAULT_MAX_SELECTIONS);
      if (values.length > max) return { ok: false, reason: "invalid" };
      // 選択肢に無い値は、オーナーが選択肢を変えた可能性が高い(ページの再読み込みで直る)。
      // 回答は前後の空白を除いているので、選択肢も同じように比べる。
      const options = new Set(question.options.map((o) => o.trim()));
      if (values.some((v) => !options.has(v))) return { ok: false, reason: "stale" };
    }

    const otherDetail =
      question.type !== "text" && values.includes(OTHER_OPTION_TEXT) ? answer.otherDetail?.trim() || undefined : undefined;
    matched.set(question.id, { question, values, otherDetail });
  }

  const ordered = survey.questions.filter((q) => matched.has(q.id)).map((q) => matched.get(q.id)!);
  if (ordered.length === 0) return { ok: false, reason: "empty" };

  const inputs: MaterialInput[] = ordered.map(({ question, values, otherDetail }) =>
    question.type === "text"
      ? { questionText: question.text, questionType: "text", selected: [], freeText: values[0] }
      : { questionText: question.text, questionType: question.type, selected: values, otherDetail },
  );

  const v1Answers: V1Answer[] = ordered.map(({ question, values, otherDetail }) => {
    const withDetail = (value: string) =>
      value === OTHER_OPTION_TEXT && otherDetail ? `${OTHER_OPTION_TEXT}（${otherDetail}）` : value;
    if (question.type === "multiple") return { question: question.text, answer: values.map(withDetail) };
    return { question: question.text, answer: withDetail(values[0]) };
  });

  return { ok: true, inputs, v1Answers };
}
