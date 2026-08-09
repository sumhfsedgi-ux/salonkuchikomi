import type { SurveyQuestion } from "@/lib/types";
import SingleSelectQuestion from "@/components/review/SingleSelectQuestion";
import MultiSelectQuestion from "@/components/review/MultiSelectQuestion";
import TextareaQuestion from "@/components/review/TextareaQuestion";

interface Props {
  question: SurveyQuestion;
  value: string[] | string;
  onChange: (value: string[] | string) => void;
  errorMessage?: string;
}

export default function QuestionCard({
  question,
  value,
  onChange,
  errorMessage,
}: Props) {
  return (
    <div className="card">
      <div className="mb-3 flex items-start gap-2">
        <p className="text-balance text-sm font-medium leading-relaxed text-stone-800">
          {question.question}
        </p>
        {question.required ? (
          <span className="mt-0.5 shrink-0 rounded bg-sage/15 px-1.5 py-0.5 text-[10px] font-medium text-sage-dark">
            必須
          </span>
        ) : (
          <span className="mt-0.5 shrink-0 rounded bg-beige px-1.5 py-0.5 text-[10px] font-medium text-stone-500">
            任意
          </span>
        )}
      </div>

      {question.type === "single" && (
        <SingleSelectQuestion
          question={question}
          selected={value as string}
          onChange={onChange}
        />
      )}
      {question.type === "multiple" && (
        <MultiSelectQuestion
          question={question}
          selected={value as string[]}
          onChange={onChange}
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
