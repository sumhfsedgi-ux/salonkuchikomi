import { redirect } from "next/navigation";

// Legacy URL kept working after the /admin/login -> /login rename.
export default function LegacyAdminLoginRedirect() {
  redirect("/login");
}
