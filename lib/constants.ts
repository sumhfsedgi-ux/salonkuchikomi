// Shared between components/review/TextareaQuestion.tsx and the
// /api/generate-review request schema, since it isn't an owner-editable
// per-question setting (see plan: kept as an app-level constant, not a DB column).
export const TEXT_ANSWER_MAX_LENGTH = 300;
