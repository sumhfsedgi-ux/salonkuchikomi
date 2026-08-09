import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon, getTemplates } from "@/lib/supabase/queries";
import OnboardingWizard from "@/components/admin/OnboardingWizard";
import SalonDashboard from "@/components/admin/SalonDashboard";

export default async function AdminHomePage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  const headersList = await headers();
  const host = `${headersList.get("x-forwarded-proto") ?? "https"}://${headersList.get("host")}`;

  if (!salon) {
    const templates = await getTemplates(supabase);
    return (
      <OnboardingWizard
        templates={templates}
        initialSalon={null}
        initialStep={1}
        host={host}
      />
    );
  }

  const { data: survey } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!survey) {
    const templates = await getTemplates(supabase);
    return (
      <OnboardingWizard
        templates={templates}
        initialSalon={salon}
        initialStep={2}
        host={host}
      />
    );
  }

  return <SalonDashboard salon={salon} customerUrl={`${host}/review/${salon.slug}`} />;
}
