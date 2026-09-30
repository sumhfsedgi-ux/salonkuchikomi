import { cache } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { OwnerSalon } from "@/lib/types";
import type { QuestionData } from "@/components/admin/QuestionEditor";

/**
 * The currently-authenticated user, memoized per request (same `supabase`
 * client in → same result out) so callers that each need it independently
 * (a layout's own check, getCurrentSalon internally) don't each pay a
 * separate Supabase Auth round trip for the same request.
 */
export const getAuthedUser = cache(async (
  supabase: SupabaseClient,
): Promise<User | null> => {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * Resolves "the salon owned by whoever is currently logged in", using only
 * the caller's own authenticated session (never a client-supplied id).
 * Every admin page/Server Action should go through this rather than trusting
 * an id passed from the client — RLS still enforces ownership underneath,
 * but this keeps the app code itself from ever needing to.
 *
 * Memoized per request: a layout and every page under it independently call
 * this with "their own" createClient() result, but since createClient() is
 * itself memoized per request, they all pass the same client instance here
 * and only the first call actually hits the database.
 */
export const getCurrentSalon = cache(async (
  supabase: SupabaseClient,
): Promise<OwnerSalon | null> => {
  const user = await getAuthedUser(supabase);
  if (!user) return null;

  // profiles->salons in one round trip via embedding, instead of two
  // sequential queries. salons has no unique constraint on owner_id, so
  // PostgREST returns it as an array even though the app only ever expects
  // one salon per owner (same assumption the rest of the codebase already
  // makes — see OnboardingWizard.tsx).
  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id, salons(id, owner_id, name, slug, google_review_url, description, business_type, onboarding_completed, plan, created_at, updated_at)",
    )
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) return null;

  const salon = profile.salons?.[0];
  if (!salon) return null;

  return {
    id: salon.id,
    ownerId: salon.owner_id,
    name: salon.name,
    slug: salon.slug,
    googleReviewUrl: salon.google_review_url,
    description: salon.description,
    businessType: salon.business_type,
    onboardingCompleted: salon.onboarding_completed,
    plan: salon.plan,
    createdAt: salon.created_at,
    updatedAt: salon.updated_at,
  };
});

/**
 * After creating/restarting a survey from a template, backfills the salon's
 * business_type from the template's name -- but only if the owner hasn't
 * already set one (never overwrites an existing value). No-op if no
 * template was used (p_template_id null, i.e. "0から作成"). Best-effort:
 * failures are logged, not surfaced, since the survey itself was already
 * created successfully by the time this runs.
 */
export async function applyDefaultBusinessType(
  supabase: SupabaseClient,
  salonId: string,
  templateId: string | null,
): Promise<void> {
  if (!templateId) return;

  const { data: salon } = await supabase
    .from("salons")
    .select("business_type")
    .eq("id", salonId)
    .maybeSingle();
  if (!salon || (salon.business_type && salon.business_type.trim() !== "")) return;

  const { data: template } = await supabase
    .from("survey_templates")
    .select("name")
    .eq("id", templateId)
    .maybeSingle();
  if (!template) return;

  const { error } = await supabase
    .from("salons")
    .update({ business_type: template.name, updated_at: new Date().toISOString() })
    .eq("id", salonId);
  if (error) {
    console.error("applyDefaultBusinessType failed to update salons", error);
  }
}

export interface ActiveSurveyWithQuestions {
  id: string;
  questions: QuestionData[];
}

/**
 * The salon's active survey plus its full question/option tree, in one
 * PostgREST request via embedded resources — instead of the 3 separate
 * sequential round trips (surveys, then questions, then question_options)
 * this replaces. Used by `/dashboard/reviews`, where that chain was the largest
 * remaining source of latency after `getCurrentSalon` was memoized.
 */
export async function getActiveSurveyWithQuestions(
  supabase: SupabaseClient,
  salonId: string,
): Promise<ActiveSurveyWithQuestions | null> {
  const { data: survey } = await supabase
    .from("surveys")
    .select(
      `id, questions(id, question_text, question_type, required, max_selections, sort_order,
        question_options(id, question_id, option_text, sort_order))`,
    )
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .order("sort_order", { referencedTable: "questions" })
    .order("sort_order", { referencedTable: "questions.question_options" })
    .maybeSingle();
  if (!survey) return null;

  const questions = survey.questions ?? [];

  return {
    id: survey.id,
    questions: questions.map((q) => ({
      id: q.id,
      question_text: q.question_text,
      question_type: q.question_type as "single" | "multiple" | "text",
      required: q.required,
      max_selections: q.max_selections,
      options: (q.question_options ?? []).map((o) => ({
        id: o.id,
        option_text: o.option_text,
      })),
    })),
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
 * expects. Shared between `/dashboard/reviews` and the onboarding wizard's
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
