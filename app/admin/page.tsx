import { redirect } from "next/navigation";

// Legacy URL kept working after the /admin -> /dashboard rename (see plan:
// don't delete old URLs immediately, redirect instead). No data is read
// here, so it's safe to leave outside the auth-gated route.
export default function LegacyAdminRedirect() {
  redirect("/dashboard");
}
