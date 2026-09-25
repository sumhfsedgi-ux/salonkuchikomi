import { redirect } from "next/navigation";

// Legacy URL kept working after the /admin/survey -> /dashboard/reviews rename.
export default function LegacyAdminSurveyRedirect() {
  redirect("/dashboard/reviews");
}
