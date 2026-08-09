import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerSalon } from "@/lib/types";
import type { QuestionData } from "@/components/admin/QuestionEditor";

/**
 * Resolves "the salon owned by whoever is currently logged in", using only
 * the caller's own authenticated session (never a client-supplied id).
 * Every admin page/Server Action should go through this rather than trusting
 * an id passed from the client — RLS still enforces ownership underneath,
 * but this keeps the app code itself from ever needing to.
 */
export async function getCurrentSalon(
  supabase: SupabaseClient,
): Promise<OwnerSalon | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) return null;

  const { data: salon } = await supabase
    .from("salons")
    .select(
      "id, owner_id, name, slug, google_review_url, description, onboarding_completed, created_at, updated_at",
    )
    .eq("owner_id", profile.id)
    .maybeSingle();
  if (!salon) return null;

  return {
    id: salon.id,
    ownerId: salon.owner_id,
    name: salon.name,
    slug: salon.slug,
    googleReviewUrl: salon.google_review_url,
    description: salon.description,
    onboardingCompleted: salon.onboarding_completed,
    createdAt: salon.created_at,
    updatedAt: salon.updated_at,
  };
}

export interface SurveyTemplateSummary {
  id: string;
  name: string;
  description: string | null;
}

/** The shared template library, for the "start from a template" picker. */
export async function getTemplates(
  supabase: SupabaseClient,
): Promise<SurveyTemplateSummary[]> {
  const { data } = await supabase
    .from("survey_templates")
    .select("id, name, description")
    .order("name");
  return data ?? [];
}

/**
 * A survey's questions and their options, in the shape `QuestionEditor`
 * expects. Shared between `/admin/survey` and the onboarding wizard's
 * question-review step, so both render the exact same editing UI.
 */
export async function getSurveyQuestionsWithOptions(
  supabase: SupabaseClient,
  surveyId: string,
): Promise<QuestionData[]> {
  const { data: questionRows } = await supabase
    .from("questions")
    .select("id, question_text, question_type, required, max_selections, sort_order")
    .eq("survey_id", surveyId)
    .order("sort_order");
  const questions = questionRows ?? [];

  const questionIds = questions.map((q) => q.id);
  const { data: optionRows } =
    questionIds.length > 0
      ? await supabase
          .from("question_options")
          .select("id, question_id, option_text, sort_order")
          .in("question_id", questionIds)
          .order("sort_order")
      : { data: [] };
  const options = optionRows ?? [];

  return questions.map((q) => ({
    id: q.id,
    question_text: q.question_text,
    question_type: q.question_type as "single" | "multiple" | "text",
    required: q.required,
    max_selections: q.max_selections,
    options: options
      .filter((o) => o.question_id === q.id)
      .map((o) => ({ id: o.id, option_text: o.option_text })),
  }));
}
