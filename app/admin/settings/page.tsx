import { redirect } from "next/navigation";

// Legacy URL kept working after the /admin/settings -> /dashboard/settings rename.
export default function LegacyAdminSettingsRedirect() {
  redirect("/dashboard/settings");
}
