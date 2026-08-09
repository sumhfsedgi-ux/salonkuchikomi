import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerSalon } from "@/lib/types";

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
    .select("id, owner_id, name, slug, google_review_url, description, created_at, updated_at")
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
