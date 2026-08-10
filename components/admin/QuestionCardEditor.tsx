"use client";

import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
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
import { SortableContext, verticalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useAutosizeTextarea, blockEnterKey } from "@/lib/useAutosizeTextarea";

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
  single: "1つだけ選ぶ",
  multiple: "3つだけ選ぶ",
  text: "自由記入欄",
};

function GripIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <circle cx="7" cy="4" r="1.3" />
      <circle cx="7" cy="10" r="1.3" />
      <circle cx="7" cy="16" r="1.3" />
      <circle cx="13" cy="4" r="1.3" />
      <circle cx="13" cy="10" r="1.3" />
      <circle cx="13" cy="16" r="1.3" />
    </svg>
  );
}

// Looks like the plain pill customers see on /review — border/background
// only appear on hover or focus, so at rest it reads as a preview of the
// real question, not a form field.
function OptionRow({
  option,
  onChange,
  onDelete,
}: {
  option: OptionData;
  onChange: (text: string) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.id,
  });
  const textareaRef = useAutosizeTextarea(option.option_text);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        "flex items-start gap-0.5 rounded-lg",
        isDragging ? "z-10 bg-white shadow-md" : "",
      ].join(" ")}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="選択肢をドラッグして並び替え"
        className="mt-1.5 flex shrink-0 touch-none cursor-grab items-center justify-center rounded p-1.5 text-stone-300 hover:text-stone-500 active:cursor-grabbing"
      >
        <GripIcon />
      </button>
      <textarea
        ref={textareaRef}
        value={option.option_text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={blockEnterKey}
        placeholder="選択肢を入力"
        rows={1}
        className="min-w-0 flex-1 resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-1.5 py-2.5 text-sm text-stone-800 transition hover:border-greige hover:bg-white focus:border-sage focus:bg-white focus:outline-none"
      />
      <button
        type="button"
        onClick={onDelete}
        className="mt-1.5 shrink-0 rounded p-1.5 text-stone-300 hover:text-red-500"
        aria-label="この選択肢を削除"
      >
        ✕
      </button>
    </div>
  );
}

function TypePicker({
  value,
  onChange,
}: {
  value: QuestionData["question_type"];
  onChange: (next: QuestionData["question_type"]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="回答方法">
      {(Object.keys(TYPE_LABELS) as QuestionData["question_type"][]).map((type) => {
        const active = value === type;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(type)}
            className={[
              "rounded-full px-3 py-1.5 text-xs font-medium transition",
              active
                ? "bg-sage/15 text-sage-dark"
                : "bg-beige/70 text-stone-500 hover:bg-beige",
            ].join(" ")}
          >
            {TYPE_LABELS[type]}
          </button>
        );
      })}
    </div>
  );
}

// Fully controlled: every interaction reports up to QuestionEditor, which
// holds the entire survey's draft state and auto-saves it in the
// background. Nothing here makes a network call directly. This card is
// itself a sortable item (question-level drag) and also hosts its own
// nested drag context for its options.
export default function QuestionCardEditor({
  question,
  onChange,
  onDelete,
  onAddOption,
  onUpdateOption,
  onDeleteOption,
  onReorderOptions,
}: {
  question: QuestionData;
  onChange: (patch: Partial<QuestionData>) => void;
  onDelete: () => void;
  onAddOption: () => void;
  onUpdateOption: (optionId: string, text: string) => void;
  onDeleteOption: (optionId: string) => void;
  onReorderOptions: (activeId: string, overId: string) => void;
}) {
  const questionTextareaRef = useAutosizeTextarea(question.question_text);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: question.id });

  const optionSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleOptionDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      onReorderOptions(String(active.id), String(over.id));
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        "rounded-2xl bg-white p-5 shadow-sm transition-shadow",
        isDragging ? "z-10 shadow-lg" : "",
      ].join(" ")}
    >
      <div className="mb-1 flex items-start gap-0.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="質問をドラッグして並び替え"
          className="mt-1.5 flex shrink-0 touch-none cursor-grab items-center justify-center rounded p-1.5 text-stone-300 hover:text-stone-500 active:cursor-grabbing"
        >
          <GripIcon />
        </button>
        <textarea
          ref={questionTextareaRef}
          value={question.question_text}
          onChange={(e) => onChange({ question_text: e.target.value })}
          onKeyDown={blockEnterKey}
          placeholder="質問を入力"
          rows={1}
          className="min-w-0 flex-1 resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-1.5 py-1.5 text-base font-medium text-stone-800 transition hover:border-greige hover:bg-ivory focus:border-sage focus:bg-white focus:outline-none"
        />
        <button
          type="button"
          onClick={() => onChange({ required: !question.required })}
          className={[
            "mt-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition",
            question.required ? "bg-sage/15 text-sage-dark" : "bg-beige text-stone-500",
          ].join(" ")}
        >
          {question.required ? "必須" : "任意"}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 pl-2 sm:pl-9">
        <TypePicker
          value={question.question_type}
          onChange={(type) =>
            onChange({ question_type: type, max_selections: type === "multiple" ? 3 : null })
          }
        />
      </div>

      {question.question_type !== "text" ? (
        <div className="mb-2 flex flex-col gap-0.5 pl-2 sm:pl-9">
          <DndContext
            sensors={optionSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleOptionDragEnd}
          >
            <SortableContext
              items={question.options.map((o) => o.id)}
              strategy={verticalListSortingStrategy}
            >
              {question.options.map((option) => (
                <OptionRow
                  key={option.id}
                  option={option}
                  onChange={(text) => onUpdateOption(option.id, text)}
                  onDelete={() => onDeleteOption(option.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
          <button
            type="button"
            onClick={onAddOption}
            className="mt-1 self-start rounded-lg border border-dashed border-greige px-3 py-2 text-xs text-stone-500 transition hover:border-sage hover:text-sage-dark"
          >
            ＋ 選択肢を追加
          </button>
        </div>
      ) : (
        <div className="mb-2 ml-2 rounded-lg border border-dashed border-greige bg-ivory/60 px-3 py-3 text-xs text-stone-400 sm:ml-9">
          お客様が自由に文章を書ける欄がここに表示されます
        </div>
      )}

      <div className="flex items-center justify-end pl-9">
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-stone-400 hover:text-red-500 hover:underline"
        >
          この質問を削除
        </button>
      </div>
    </div>
  );
}
