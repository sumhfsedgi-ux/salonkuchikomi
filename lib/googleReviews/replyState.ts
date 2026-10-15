import type { ReviewBucket, ReviewFilter, ReviewSummary } from "@/lib/googleReviews/types";

// 返信の状態の表示(計画 第2版 §2「返信の状態」)。DB の gbp_reply_op_display・gbp_reply_bucket と同じ規則。
// 上の条件ほど優先し、当てはまった1つを表示する。Google の状態は、取り直した Google のデータだけで決める。
// 下書きはここに含めず、補助の情報として別に出す。

export type ReplyDisplayState =
  | "sending"
  | "checking"
  | "send_failed"
  | "replace_failed"
  | "delete_failed"
  | "rejected"
  | "pending"
  | "approved"
  | "replied"
  | "unreplied";

export function replyDisplayState(review: Pick<ReviewSummary, "reply" | "operation">): ReplyDisplayState {
  switch (review.operation) {
    case "sending":
      return "sending";
    case "unknown":
    case "sent_checking":
      return "checking";
    case "send_failed":
      if (!review.reply) return "send_failed";
      break;
    case "replace_failed":
      return "replace_failed";
    case "delete_failed":
      return "delete_failed";
  }
  if (review.reply?.state === "REJECTED") return "rejected";
  if (!review.reply) return "unreplied";
  if (review.reply.state === "PENDING") return "pending";
  if (review.reply.state === "APPROVED") return "approved";
  return "replied";
}

/** その状態が入る絞り込み(DB の gbp_reply_bucket と同じ)。 */
export function replyBucket(state: ReplyDisplayState): ReviewBucket {
  switch (state) {
    case "sending":
    case "checking":
    case "replace_failed":
    case "delete_failed":
    case "rejected":
      return "attention";
    case "send_failed":
    case "unreplied":
      return "unreplied";
    default:
      return "replied";
  }
}

/**
 * その口コミが今の絞り込みに入るか(詳細で操作したあと、一覧の行が絞り込みの対象外になったかを示すのに使う)。
 * 分類は replyBucket(DB の gbp_reply_bucket と同じ規則)で、画面で変えた状態からも決める。
 */
export function matchesFilter(review: Pick<ReviewSummary, "reply" | "operation" | "isNew">, filter: ReviewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "new") return review.isNew;
  return replyBucket(replyDisplayState(review)) === filter;
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger";

export const REPLY_STATE_VIEW: Record<ReplyDisplayState, { label: string; tone: BadgeTone; alert: boolean }> = {
  sending: { label: "送信中…", tone: "neutral", alert: false },
  checking: { label: "送信結果を確認中", tone: "warning", alert: true },
  send_failed: { label: "送信できませんでした", tone: "danger", alert: true },
  replace_failed: { label: "置き換えできませんでした", tone: "danger", alert: true },
  delete_failed: { label: "削除できませんでした", tone: "danger", alert: true },
  rejected: { label: "公開できませんでした", tone: "danger", alert: true },
  pending: { label: "審査中", tone: "neutral", alert: false },
  approved: { label: "公開済み", tone: "success", alert: false },
  replied: { label: "返信済み", tone: "success", alert: false },
  unreplied: { label: "未返信", tone: "warning", alert: false },
};

/** 状態ごとの補足(詳細の返信の欄に出す)。結果が分からない状態では、もう一度送るよう促さない。 */
export const REPLY_STATE_NOTE: Partial<Record<ReplyDisplayState, string>> = {
  checking: "Googleに送った返信が反映されたかを、まだ確認できていません。「Googleで確認する」で最新の状態を取り直してください。確認できるまで、もう一度送らないでください。",
  send_failed: "前回の送信はGoogleに反映されていません。文章を確認して、もう一度送れます。送らない場合は「送るのをやめる」でこの表示を消せます(Googleには何も送りません)。",
  replace_failed: "置き換えできませんでした。以前の返信がGoogleに残っています。",
  delete_failed: "削除できませんでした。返信がGoogleに残っています。",
};

// policyViolation の説明。知らない値は一般的な文にして、コードを小さく添える。
const POLICY_GROUPS: { codes: string[]; message: string }[] = [
  {
    codes: ["ADVERTISING_AND_SOLICITATION"],
    message: "宣伝や勧誘と判断されました。URL・電話番号・クーポンなどを含めずに書き直してください。",
  },
  { codes: ["PERSONAL_INFO", "PRIVACY"], message: "個人を特定できる情報が含まれていると判断されました。" },
  {
    codes: ["OFFENSIVE", "HARASSMENT", "HATE_SPEECH", "OBSCENITY_AND_PROFANITY", "VIOLENCE_AND_GORE", "SEXUALLY_EXPLICIT", "ADULT_THEMED"],
    message: "不適切な表現と判断されました。",
  },
  {
    codes: ["OFF_TOPIC", "GIBBERISH_AND_REPETITIVE", "REPETITIVE", "UNCLEAR"],
    message: "口コミと関係のない内容や、繰り返しと判断されました。",
  },
  {
    codes: ["MISINFORMATION", "MISREPRESENTATION", "IMPERSONATION", "FAKE_ENGAGEMENT"],
    message: "事実と異なる、または不自然な内容と判断されました。",
  },
  {
    codes: [
      "ACCOUNT_RESTRICTED_AND_SUSPENDED",
      "ACCOUNT_RESTRICTED_AND_EDIT_REJECTED",
      "ASSOCIATED_ACCOUNT_SUSPENDED",
      "LOCATION_SUSPENDED",
      "LOCATION_DISABLED",
      "LOCATION_VERIFICATION_REQUIRED",
      "OWNERSHIP_REVOKED",
      "EDITING_RESTRICTION",
      "BUSINESS_INELIGIBLE",
    ],
    message: "返信の内容ではなく、Googleビジネスプロフィールの状態が原因の可能性があります。Googleで確認してください。",
  },
  { codes: ["MODERATION_ERROR"], message: "Google側の審査でエラーが起きました。時間をおいて、Googleで確認してください。" },
];

export function policyViolationMessage(code: string | null): { message: string; code: string | null } {
  const group = code ? POLICY_GROUPS.find((g) => g.codes.includes(code)) : undefined;
  return {
    message: group?.message ?? "Googleのポリシーにより公開されませんでした。内容を見直してください。",
    code: group ? null : code,
  };
}
