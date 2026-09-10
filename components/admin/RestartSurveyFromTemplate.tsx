"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import TemplatePicker from "@/components/admin/TemplatePicker";
import { restartSurveyAction } from "@/app/dashboard/reviews/actions";
import type { SurveyTemplateSummary } from "@/lib/supabase/queries";

export default function RestartSurveyFromTemplate({
  templates,
}: {
  templates: SurveyTemplateSummary[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRestarted, setJustRestarted] = useState(false);

  async function handleSelect(templateId: string | null) {
    setError(null);
    const result = await restartSurveyAction(templateId);
    if (result.error) {
      setError(result.error);
      return;
    }
    // QuestionEditor above seeds its draft from props only once, keyed on
    // the survey id -- router.refresh() re-fetches that id (restarting
    // creates a new survey row) so it actually remounts with the new
    // template's questions instead of silently keeping the old ones.
    router.refresh();
    setJustRestarted(true);
  }

  function handleConfirm() {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setOpen(false);
    setJustRestarted(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-sm font-medium text-stone-400 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-600"
      >
        テンプレートから作り直す
      </button>
    );
  }

  if (justRestarted) {
    return (
      <div className="rounded-2xl bg-sage/10 p-5">
        <p className="text-sm font-medium text-sage-dark">テンプレートを反映しました</p>
        <p className="mt-1 text-sm text-sage-dark/80">
          上部の「お客様への質問」に新しい内容が反映されています。内容をご確認ください。
        </p>
        <button
          type="button"
          onClick={handleConfirm}
          className="mt-4 rounded-lg bg-sage px-6 py-2.5 text-sm font-medium text-white transition hover:bg-sage-dark"
        >
          内容を確認する
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-earth/10 p-5">
      <p className="text-sm font-medium text-earth">テンプレートから作り直しますか？</p>
      <p className="mt-1 text-sm text-stone-600">
        選んだテンプレートの内容に置き換わり、現在の質問・選択肢はお客様用ページに表示されなくなります。この操作は元に戻せません。
      </p>
      <div className="mt-4">
        <TemplatePicker templates={templates} onSelect={handleSelect} error={error} />
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-3 text-sm text-stone-500 underline decoration-stone-300 underline-offset-4"
      >
        キャンセル
      </button>
    </div>
  );
}
