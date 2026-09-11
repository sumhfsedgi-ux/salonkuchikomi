"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { deletePost } from "@/lib/blog/queries";

export async function deletePostAction(id: string) {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/login");

  await deletePost(salon.id, id);
  revalidatePath("/dashboard/blog/history");
  redirect("/dashboard/blog/history");
}
