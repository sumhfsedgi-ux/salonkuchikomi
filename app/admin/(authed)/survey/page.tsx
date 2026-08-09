import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import QuestionEditor from "@/components/admin/QuestionEditor";

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

  const { data: questionRows } = await supabase
    .from("questions")
    .select("id, question_text, question_type, required, max_selections, sort_order")
    .eq("survey_id", survey.id)
    .order("sort_order");
  const questions = questionRows ?? [];

  const questionIds = questions.map((q) => q.id);
  const { data: optionRows } =
    questionIds.length > 0
      ? await supabase
          .from("question_options")
          .select("id, question_id, option_text, sort_order")
          .in("question_id", questionIds)
          .order("sort_order")
      : { data: [] };
  const options = optionRows ?? [];

  const questionsWithOptions = questions.map((q) => ({
    id: q.id,
    question_text: q.question_text,
    question_type: q.question_type as "single" | "multiple" | "text",
    required: q.required,
    max_selections: q.max_selections,
    options: options
      .filter((o) => o.question_id === q.id)
      .map((o) => ({ id: o.id, option_text: o.option_text })),
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">口コミアンケート設定</h1>
        <p className="mt-1 text-sm text-slate-500">
          お客様に聞く質問と選択肢を編集できます。変更はすぐにお客様用ページへ反映されます。
        </p>
      </div>
      <QuestionEditor questions={questionsWithOptions} />
    </div>
  );
}
