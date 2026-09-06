import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TEXT_ANSWER_MAX_LENGTH } from "@/lib/constants";
import type { SurveyQuestion } from "@/lib/types";
import ReviewFlow from "@/components/review/ReviewFlow";

interface QuestionRow {
  id: string;
  question_text: string;
  question_type: "single" | "multiple" | "text";
  required: boolean;
  max_selections: number | null;
  sort_order: number;
}

interface OptionRow {
  id: string;
  question_id: string;
  option_text: string;
  sort_order: number;
}

// Memoized per request: generateMetadata and the page component both need
// this, and without cache() each one independently re-runs all 4 queries.
const getSalonAndQuestions = cache(async (slug: string) => {
  const supabase = await createClient();

  const { data: salon } = await supabase
    .from("salon_public")
    .select("id, name, slug, google_review_url, description, business_type")
    .eq("slug", slug)
    .maybeSingle();
  if (!salon) return null;

  const { data: survey } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!survey) return null;

  const { data: questionRows } = await supabase
    .from("questions")
    .select("id, question_text, question_type, required, max_selections, sort_order")
    .eq("survey_id", survey.id)
    .order("sort_order")
    .returns<QuestionRow[]>();
  const questions = questionRows ?? [];

  const questionIds = questions.map((q) => q.id);
  const { data: optionRows } =
    questionIds.length > 0
      ? await supabase
          .from("question_options")
          .select("id, question_id, option_text, sort_order")
          .in("question_id", questionIds)
          .order("sort_order")
          .returns<OptionRow[]>()
      : { data: [] as OptionRow[] };
  const options = optionRows ?? [];

  const surveyQuestions: SurveyQuestion[] = questions.map((q) => {
    const questionOptions = options
      .filter((o) => o.question_id === q.id)
      .map((o) => o.option_text);

    if (q.question_type === "single") {
      return {
        id: q.id,
        question: q.question_text,
        required: q.required,
        sortOrder: q.sort_order,
        type: "single",
        options: questionOptions,
      };
    }
    if (q.question_type === "multiple") {
      return {
        id: q.id,
        question: q.question_text,
        required: q.required,
        sortOrder: q.sort_order,
        type: "multiple",
        options: questionOptions,
        maxSelections: q.max_selections ?? 3,
      };
    }
    return {
      id: q.id,
      question: q.question_text,
      required: q.required,
      sortOrder: q.sort_order,
      type: "text",
      maxLength: TEXT_ANSWER_MAX_LENGTH,
    };
  });

  return {
    salon: {
      id: salon.id as string,
      name: salon.name as string,
      googleReviewUrl: (salon.google_review_url as string | null) ?? "",
      businessType: (salon.business_type as string | null) ?? null,
    },
    questions: surveyQuestions,
  };
});

export async function generateMetadata({
  params,
}: PageProps<"/review/[slug]">) {
  const { slug } = await params;
  const data = await getSalonAndQuestions(slug);
  return {
    title: data ? `${data.salon.name} | 口コミ作成` : "店舗が見つかりません",
  };
}

export default async function ReviewPage({
  params,
}: PageProps<"/review/[slug]">) {
  const { slug } = await params;
  const data = await getSalonAndQuestions(slug);
  if (!data) notFound();

  return <ReviewFlow salon={data.salon} questions={data.questions} />;
}
