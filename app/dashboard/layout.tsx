import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import DashboardShell from "@/components/layout/DashboardShell";
import { SERVICE_NAME } from "@/lib/brand";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");

  const salon = await getCurrentSalon(supabase);

  return <DashboardShell salonName={salon?.name ?? SERVICE_NAME}>{children}</DashboardShell>;
}
