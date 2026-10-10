import type { SurveyQuestion } from "@/lib/types";
import SingleSelectQuestion from "@/components/review/SingleSelectQuestion";
import MultiSelectQuestion from "@/components/review/MultiSelectQuestion";
import TextareaQuestion from "@/components/review/TextareaQuestion";

interface Props {
  question: SurveyQuestion;
  index: number;
  value: string[] | string;
  onChange: (value: string[] | string) => void;
  otherDetail: string;
  onOtherDetailChange: (text: string) => void;
  errorMessage?: string;
}

export default function QuestionCard({
  question,
  index,
  value,
  onChange,
  otherDetail,
  onOtherDetailChange,
  errorMessage,
}: Props) {
  return (
    <div className="card" data-question-id={question.id}>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="shrink-0 text-xs font-semibold text-sage-dark">
          {String(index + 1).padStart(2, "0")}
        </span>
        <p className="text-sm font-medium leading-relaxed text-stone-800">
          {question.question}
        </p>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {question.required ? (
          <span className="rounded bg-sage/15 px-1.5 py-0.5 text-[10px] font-medium text-sage-dark">
            必須
          </span>
        ) : (
          <span className="rounded bg-beige px-1.5 py-0.5 text-[10px] font-medium text-stone-500">
            任意
          </span>
        )}
        {question.type === "multiple" && (
          <span className="rounded bg-beige px-1.5 py-0.5 text-[10px] font-medium text-stone-500">
            最大{question.maxSelections}つ
          </span>
        )}
      </div>

      {question.type === "single" && (
        <SingleSelectQuestion
          question={question}
          selected={value as string}
          onChange={onChange}
          otherDetail={otherDetail}
          onOtherDetailChange={onOtherDetailChange}
        />
      )}
      {question.type === "multiple" && (
        <MultiSelectQuestion
          question={question}
          selected={value as string[]}
          onChange={onChange}
          otherDetail={otherDetail}
          onOtherDetailChange={onOtherDetailChange}
        />
      )}
      {question.type === "text" && (
        <TextareaQuestion
          question={question}
          value={value as string}
          onChange={onChange}
        />
      )}

      {errorMessage && (
        <p className="mt-2 text-xs text-red-500">{errorMessage}</p>
      )}
    </div>
  );
}
