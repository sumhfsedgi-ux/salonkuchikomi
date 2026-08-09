"use client";

import { useState } from "react";
import {
  updateQuestionAction,
  deleteQuestionAction,
  reorderQuestionAction,
  addOptionAction,
  updateOptionAction,
  deleteOptionAction,
  reorderOptionAction,
} from "@/app/admin/(authed)/survey/actions";

interface OptionData {
  id: string;
  option_text: string;
}

interface QuestionData {
  id: string;
  question_text: string;
  question_type: "single" | "multiple" | "text";
  required: boolean;
  max_selections: number | null;
  options: OptionData[];
}

const TYPE_LABELS: Record<QuestionData["question_type"], string> = {
  single: "単一選択",
  multiple: "複数選択",
  text: "自由記述",
};

function OptionRow({ option, isFirst, isLast }: { option: OptionData; isFirst: boolean; isLast: boolean }) {
  const [text, setText] = useState(option.option_text);
  const [busy, setBusy] = useState(false);

  async function handleBlur() {
    if (text.trim() === option.option_text || !text.trim()) return;
    setBusy(true);
    const formData = new FormData();
    formData.set("option_text", text.trim());
    await updateOptionAction(option.id, formData);
    setBusy(false);
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        disabled={busy}
        className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
      />
      <button
        type="button"
        disabled={isFirst || busy}
        onClick={() => reorderOptionAction(option.id, "up")}
        className="rounded p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"
        aria-label="上へ"
      >
        ↑
      </button>
      <button
        type="button"
        disabled={isLast || busy}
        onClick={() => reorderOptionAction(option.id, "down")}
        className="rounded p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"
        aria-label="下へ"
      >
        ↓
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => deleteOptionAction(option.id)}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
      >
        削除
      </button>
    </div>
  );
}

export default function QuestionCardEditor({
  question,
  isFirst,
  isLast,
}: {
  question: QuestionData;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [questionText, setQuestionText] = useState(question.question_text);
  const [questionType, setQuestionType] = useState(question.question_type);
  const [required, setRequired] = useState(question.required);
  const [maxSelections, setMaxSelections] = useState(question.max_selections ?? 3);
  const [newOptionText, setNewOptionText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSaveQuestion() {
    setSaving(true);
    setError(null);
    setSavedMessage(false);
    const formData = new FormData();
    formData.set("question_text", questionText);
    formData.set("question_type", questionType);
    if (required) formData.set("required", "on");
    formData.set("max_selections", questionType === "multiple" ? String(maxSelections) : "");
    const result = await updateQuestionAction(question.id, formData);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSavedMessage(true);
  }

  async function handleAddOption() {
    if (!newOptionText.trim()) return;
    const formData = new FormData();
    formData.set("option_text", newOptionText.trim());
    const result = await addOptionAction(question.id, formData);
    if (!result.error) setNewOptionText("");
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">質問文</label>
          <input
            value={questionText}
            onChange={(e) => setQuestionText(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div className="flex shrink-0 flex-col gap-1 pt-5">
          <button
            type="button"
            disabled={isFirst}
            onClick={() => reorderQuestionAction(question.id, "up")}
            className="rounded p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            aria-label="質問を上へ"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={isLast}
            onClick={() => reorderQuestionAction(question.id, "down")}
            className="rounded p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            aria-label="質問を下へ"
          >
            ↓
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">種類</label>
          <select
            value={questionType}
            onChange={(e) => setQuestionType(e.target.value as QuestionData["question_type"])}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
          >
            {(Object.keys(TYPE_LABELS) as QuestionData["question_type"][]).map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="h-4 w-4"
          />
          必須にする
        </label>

        {questionType === "multiple" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">最大選択数</label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxSelections}
              onChange={(e) => setMaxSelections(Number(e.target.value))}
              className="w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </div>
        )}
      </div>

      {questionType !== "text" && (
        <div className="mb-4 flex flex-col gap-2">
          <label className="text-xs font-medium text-slate-500">選択肢</label>
          {question.options.map((option, i) => (
            <OptionRow
              key={option.id}
              option={option}
              isFirst={i === 0}
              isLast={i === question.options.length - 1}
            />
          ))}
          <div className="flex items-center gap-2">
            <input
              value={newOptionText}
              onChange={(e) => setNewOptionText(e.target.value)}
              placeholder="新しい選択肢"
              className="flex-1 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAddOption}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
            >
              ＋ 選択肢を追加
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-600">
          {error}
        </div>
      )}
      {savedMessage && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">
          保存しました。
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={handleSaveQuestion}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-900 disabled:opacity-50"
        >
          {saving ? "保存しています..." : "質問を保存"}
        </button>
        <button
          type="button"
          onClick={() => deleteQuestionAction(question.id)}
          className="text-xs text-red-500 hover:underline"
        >
          この質問を削除
        </button>
      </div>
    </div>
  );
}
