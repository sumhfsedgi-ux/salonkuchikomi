import type { SalonPlan } from "@/lib/access/plan";
import type { RegistrationSource, ServiceStatus } from "@/lib/onboarding/serviceStatus";

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
  businessType: string | null;
}

// The full salon row, only ever readable/writable by its owner via RLS.
export interface OwnerSalon extends PublicSalon {
  ownerId: string;
  onboardingCompleted: boolean;
  // 契約プラン(lib/access/plan.ts参照)。常に管理者が確定させる値で、
  // APP_MODEから自動的に導出してはならない。
  plan: SalonPlan;
  // 利用区分(lib/onboarding/serviceStatus.ts)。プランとは別に、運営だけが変える。
  serviceStatus: ServiceStatus;
  registrationSource: RegistrationSource;
  // 担当者・連絡先(contactEmail が null なら「ログイン用と同じ」)
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  updatedAt: string;
}
