export type QuestionType = "single" | "multiple" | "text";

interface BaseQuestion {
  id: string;
  question: string;
  required: boolean;
  sortOrder: number;
}

export interface SingleSelectQuestion extends BaseQuestion {
  type: "single";
  options: string[];
}

export interface MultiSelectQuestion extends BaseQuestion {
  type: "multiple";
  options: string[];
  maxSelections: number;
}

export interface TextQuestion extends BaseQuestion {
  type: "text";
  maxLength: number;
}

export type SurveyQuestion = SingleSelectQuestion | MultiSelectQuestion | TextQuestion;

// Keyed by question.id.
export type SurveyAnswers = Record<string, string | string[]>;

// The safe, publicly-readable subset of a salon (matches the `salon_public` view).
export interface PublicSalon {
  id: string;
  name: string;
  slug: string;
  googleReviewUrl: string | null;
  description: string | null;
}

// The full salon row, only ever readable/writable by its owner via RLS.
export interface OwnerSalon extends PublicSalon {
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}
