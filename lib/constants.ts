// Shared between components/review/TextareaQuestion.tsx and the
// /api/generate-review request schema, since it isn't an owner-editable
// per-question setting (see plan: kept as an app-level constant, not a DB column).
export const TEXT_ANSWER_MAX_LENGTH = 300;

// Free-text elaboration shown when a customer selects the "その他" option.
// Kept short enough that "その他（…）" plus this text still fits under
// /api/generate-review's 100-char-per-answer cap (bodySchema).
export const OTHER_DETAIL_MAX_LENGTH = 80;

// Matched by exact string against template/question option text (see
// supabase/seed.sql) to decide when to show the elaboration field above.
export const OTHER_OPTION_TEXT = "その他";
