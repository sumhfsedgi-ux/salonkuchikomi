// お客様ページ(/review/[slug])の進み方。画面(components/review/ReviewFlow.tsx)から取り出した純粋な状態遷移で、
// node のテストで確かめる(__tests__/lib/reviewFlow/flowState.test.ts)。
//
//   STEP 1 回答 → STEP 2 文章の確認 → STEP 3 投稿のご案内
//   ・アンケートを送ったら、すぐ STEP 2 にして作成中の表示を出す。作成が終わったら、そのまま文章を出す
//     (作成中の表示のための待ち時間は入れない)。
//   ・「口コミをコピーして進む」は、コピーできたときだけ STEP 3 へ進む(「コピーしました」)。
//     コピーできなかったときは STEP 2 に残り、手動でコピーしてから STEP 3 へ進める(行き止まりにしない)。
//   ・STEP 3 から「文章を編集する」で STEP 2 に戻っても、文章はそのまま残る。
//   ・作り直し(もう一度作成する)の間と、作り直しに失敗したときも、今の文章は残す。
//   ・Google から戻ってきても、何も変えない(投稿の完了は扱わない)。

export type FlowStep = 1 | 2 | 3;

export interface FlowState {
  step: FlowStep;
  /** 今の文章(お客様が編集したあとの最新)。まだ作っていなければ空。 */
  review: string;
  generating: boolean;
  error: string | null;
  /** 直前のコピーに失敗した(手動でコピーする案内を出す)。 */
  copyFailed: boolean;
  /** STEP 3 に、コピーできて進んだか(見出しを「口コミをコピーしました」にするか)。 */
  copied: boolean;
}

export type FlowAction =
  | { type: "survey_submitted" }
  | { type: "generate_started" }
  | { type: "generate_succeeded"; review: string }
  | { type: "generate_failed"; error: string }
  | { type: "review_edited"; review: string }
  | { type: "copy_succeeded" }
  | { type: "copy_failed" }
  | { type: "manual_copy_confirmed" }
  | { type: "back_to_edit" };

export const INITIAL_FLOW_STATE: FlowState = {
  step: 1,
  review: "",
  generating: false,
  error: null,
  copyFailed: false,
  copied: false,
};

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "survey_submitted":
      return { ...state, step: 2, generating: true, error: null, copyFailed: false };
    case "generate_started":
      return { ...state, generating: true, error: null, copyFailed: false };
    case "generate_succeeded":
      return { ...state, review: action.review, generating: false, error: null };
    case "generate_failed":
      return { ...state, generating: false, error: action.error };
    case "review_edited":
      return { ...state, review: action.review };
    case "copy_succeeded":
      if (state.step !== 2 || state.generating || !state.review) return state;
      return { ...state, step: 3, copied: true, copyFailed: false };
    case "copy_failed":
      if (state.step !== 2) return state;
      return { ...state, copyFailed: true };
    case "manual_copy_confirmed":
      if (state.step !== 2 || state.generating || !state.review) return state;
      return { ...state, step: 3, copied: false, copyFailed: false };
    case "back_to_edit":
      if (state.step !== 3) return state;
      return { ...state, step: 2, copied: false, copyFailed: false };
  }
}

export type GeneratingView = "showcase" | "skeleton" | "inline" | null;

/**
 * 作成中に何を出すか。
 *   ・1回目(文章がまだ無い): 店舗の表示が設定されていれば showcase、無ければ skeleton(シンプルな表示)
 *   ・作り直し(文章がある): 今の文章を残したまま、行の中の小さな表示(inline)。店舗の表示は出さない。
 */
export function generatingView(state: Pick<FlowState, "generating" | "review">, hasShowcase: boolean): GeneratingView {
  if (!state.generating) return null;
  if (state.review) return "inline";
  return hasShowcase ? "showcase" : "skeleton";
}
