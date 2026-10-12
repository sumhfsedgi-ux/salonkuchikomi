import { redirect } from "next/navigation";
import { requireOperator } from "@/lib/ops/operator";

export default async function OpsIndexPage() {
  await requireOperator();
  redirect("/ops/salons");
}
