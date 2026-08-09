import type { SurveyQuestion } from "@/config/survey";
import MultiSelectQuestion from "@/components/MultiSelectQuestion";
import TextareaQuestion from "@/components/TextareaQuestion";

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
        <p className="text-sm font-medium leading-relaxed text-stone-800">
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

      {question.type === "multi-select" ? (
        <MultiSelectQuestion
          question={question}
          selected={value as string[]}
          onChange={onChange}
        />
      ) : (
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
