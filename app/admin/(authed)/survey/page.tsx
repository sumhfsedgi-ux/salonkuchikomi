import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon, getTemplates, getActiveSurveyWithQuestions } from "@/lib/supabase/queries";
import QuestionEditor from "@/components/admin/QuestionEditor";
import RestartSurveyFromTemplate from "@/components/admin/RestartSurveyFromTemplate";

export default async function AdminSurveyPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/admin");

  const [survey, templates] = await Promise.all([
    getActiveSurveyWithQuestions(supabase, salon.id),
    getTemplates(supabase),
  ]);
  if (!survey) redirect("/admin");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-stone-800">お客様への質問</h1>
        <p className="mt-1 text-sm text-stone-500">
          文字をタップして書き換えられます。変更はそのまま保存されます。
        </p>
      </div>
      <QuestionEditor key={survey.id} questions={survey.questions} />
      <RestartSurveyFromTemplate templates={templates} />
    </div>
  );
}
