import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon, getTemplates, getSurveyQuestionsWithOptions } from "@/lib/supabase/queries";
import QuestionEditor from "@/components/admin/QuestionEditor";
import RestartSurveyFromTemplate from "@/components/admin/RestartSurveyFromTemplate";

export default async function AdminSurveyPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/admin");

  const { data: survey } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!survey) redirect("/admin");

  const questionsWithOptions = await getSurveyQuestionsWithOptions(supabase, survey.id);
  const templates = await getTemplates(supabase);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-stone-800">お客様への質問</h1>
        <p className="mt-1 text-sm text-stone-500">
          文字をタップして書き換えられます。変更はそのまま保存されます。
        </p>
      </div>
      <QuestionEditor key={survey.id} questions={questionsWithOptions} />
      <RestartSurveyFromTemplate templates={templates} />
    </div>
  );
}
