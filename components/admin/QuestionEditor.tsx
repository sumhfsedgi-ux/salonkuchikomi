"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import QuestionCardEditor from "@/components/admin/QuestionCardEditor";
import { saveSurveyAction } from "@/app/admin/(authed)/survey/actions";

export interface OptionData {
  id: string;
  option_text: string;
}

export interface QuestionData {
  id: string;
  question_text: string;
  question_type: "single" | "multiple" | "text";
  required: boolean;
  max_selections: number | null;
  options: OptionData[];
}

export interface QuestionEditorHandle {
  saveAll: () => Promise<{ error?: string }>;
}

let tempIdCounter = 0;
function tempId() {
  tempIdCounter += 1;
  return `new-${Date.now()}-${tempIdCounter}`;
}

const AUTOSAVE_DELAY_MS = 800;

// Below this many required questions, customers could leave every question
// optional/blank and the AI would have nothing to work with -- see
// saveSurveyAction, which enforces the same minimum server-side as a backstop.
const MIN_REQUIRED_QUESTIONS = 2;

// Whether the draft has everything it needs to be saved as-is. Used to hold
// off autosaving while a just-added question/option is still blank (e.g.
// right after "＋ 質問を追加"), so the status text doesn't flash an error
// the moment someone starts typing.
function isDraftComplete(draft: QuestionData[]): boolean {
  return draft.every((q) => {
    if (!q.question_text.trim()) return false;
    if (q.question_type === "text") return true;
    return q.options.length > 0 && q.options.every((o) => o.option_text.trim());
  });
}

function countRequired(draft: QuestionData[]): number {
  return draft.filter((q) => q.required).length;
}

// Holds the entire survey's questions/options as local-only draft state.
// Add/delete/reorder/edit only ever touch this state; a short time after
// the draft settles, it's auto-saved in one round trip that replaces the
// whole question/option tree (supabase/migrations/0007_save_survey_questions.sql).
// There's no manual save button -- the small status text at the top is the
// only feedback the owner needs. saveAll() is still exposed via ref so the
// onboarding wizard can flush a pending save before moving to the next step.
const QuestionEditor = forwardRef<QuestionEditorHandle, { questions: QuestionData[] }>(
  function QuestionEditor({ questions }, ref) {
    const [draft, setDraft] = useState<QuestionData[]>(questions);
    const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [error, setError] = useState<string | null>(null);

    const draftRef = useRef(draft);
    draftRef.current = draft;
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipNextAutosave = useRef(true);

    const flush = useCallback(async (): Promise<{ error?: string }> => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setStatus("saving");
      setError(null);
      const result = await saveSurveyAction(
        draftRef.current.map((q) => ({
          question_text: q.question_text,
          question_type: q.question_type,
          required: q.required,
          max_selections: q.max_selections,
          options: q.options.map((o) => ({ option_text: o.option_text })),
        })),
      );
      if (result.error) {
        setStatus("error");
        setError(result.error);
        return result;
      }
      setStatus("saved");
      return {};
    }, []);

    useImperativeHandle(ref, () => ({ saveAll: flush }), [flush]);

    useEffect(() => {
      if (skipNextAutosave.current) {
        skipNextAutosave.current = false;
        return;
      }
      setStatus("idle");
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (!isDraftComplete(draft)) return;
      if (countRequired(draft) < MIN_REQUIRED_QUESTIONS) return;
      timeoutRef.current = setTimeout(() => {
        void flush();
      }, AUTOSAVE_DELAY_MS);
      return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
    }, [draft, flush]);

    function updateQuestion(id: string, patch: Partial<QuestionData>) {
      setDraft((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
    }

    function deleteQuestion(id: string) {
      setDraft((prev) => prev.filter((q) => q.id !== id));
    }

    function handleQuestionDragEnd(event: DragEndEvent) {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setDraft((prev) => {
        const oldIndex = prev.findIndex((q) => q.id === active.id);
        const newIndex = prev.findIndex((q) => q.id === over.id);
        if (oldIndex === -1 || newIndex === -1) return prev;
        return arrayMove(prev, oldIndex, newIndex);
      });
    }

    function addQuestion() {
      setDraft((prev) => [
        ...prev,
        {
          id: tempId(),
          question_text: "",
          question_type: "multiple",
          required: true,
          max_selections: 3,
          options: [],
        },
      ]);
    }

    function addOption(questionId: string) {
      setDraft((prev) =>
        prev.map((q) =>
          q.id === questionId
            ? { ...q, options: [...q.options, { id: tempId(), option_text: "" }] }
            : q,
        ),
      );
    }

    function updateOption(questionId: string, optionId: string, text: string) {
      setDraft((prev) =>
        prev.map((q) =>
          q.id === questionId
            ? {
                ...q,
                options: q.options.map((o) => (o.id === optionId ? { ...o, option_text: text } : o)),
              }
            : q,
        ),
      );
    }

    function deleteOption(questionId: string, optionId: string) {
      setDraft((prev) =>
        prev.map((q) =>
          q.id === questionId ? { ...q, options: q.options.filter((o) => o.id !== optionId) } : q,
        ),
      );
    }

    function reorderOptions(questionId: string, activeId: string, overId: string) {
      setDraft((prev) =>
        prev.map((q) => {
          if (q.id !== questionId) return q;
          const oldIndex = q.options.findIndex((o) => o.id === activeId);
          const newIndex = q.options.findIndex((o) => o.id === overId);
          if (oldIndex === -1 || newIndex === -1) return q;
          return { ...q, options: arrayMove(q.options, oldIndex, newIndex) };
        }),
      );
    }

    const questionSensors = useSensors(
      useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
      useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
      useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const missingRequired = Math.max(0, MIN_REQUIRED_QUESTIONS - countRequired(draft));

    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-stone-400">
            ⠿ をドラッグすると順番を変えられます。入力するとそのまま保存されます。
          </p>
          <p
            className={[
              "text-xs font-medium",
              status === "saving"
                ? "text-stone-400"
                : status === "saved"
                  ? "text-sage-dark"
                  : status === "error"
                    ? "text-red-500"
                    : "text-transparent",
            ].join(" ")}
          >
            {status === "saving" && "保存中…"}
            {status === "saved" && "✓ 保存済み"}
            {status === "error" && "保存できませんでした"}
            {status === "idle" && "・"}
          </p>
        </div>

        {missingRequired > 0 && (
          <div className="rounded-lg border border-earth/30 bg-earth/10 p-3 text-sm text-earth">
            口コミ作成に必要な情報を確保するため、必須項目をあと{missingRequired}問設定してください
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <DndContext
          sensors={questionSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleQuestionDragEnd}
        >
          <SortableContext items={draft.map((q) => q.id)} strategy={verticalListSortingStrategy}>
            {draft.map((question) => (
              <QuestionCardEditor
                key={question.id}
                question={question}
                onChange={(patch) => updateQuestion(question.id, patch)}
                onDelete={() => deleteQuestion(question.id)}
                onAddOption={() => addOption(question.id)}
                onUpdateOption={(optionId, text) => updateOption(question.id, optionId, text)}
                onDeleteOption={(optionId) => deleteOption(question.id, optionId)}
                onReorderOptions={(activeId, overId) => reorderOptions(question.id, activeId, overId)}
              />
            ))}
          </SortableContext>
        </DndContext>

        <button
          type="button"
          onClick={addQuestion}
          className="rounded-2xl border border-dashed border-greige py-4 text-sm font-medium text-stone-500 transition hover:border-sage hover:text-sage-dark"
        >
          ＋ 質問を追加
        </button>
      </div>
    );
  },
);

export default QuestionEditor;
