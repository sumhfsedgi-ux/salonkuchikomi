import { describe, expect, it } from "vitest";
import { INITIAL_FLOW_STATE, flowReducer, generatingView, type FlowAction, type FlowState } from "@/lib/reviewFlow/flowState";

function run(...actions: FlowAction[]): FlowState {
  return actions.reduce(flowReducer, INITIAL_FLOW_STATE);
}

const generated = (review = "作成した文章"): FlowAction[] => [
  { type: "survey_submitted" },
  { type: "generate_started" },
  { type: "generate_succeeded", review },
];

describe("お客様ページの進み方(回答 → 文章の確認 → 投稿のご案内)", () => {
  it("アンケートを送ると、すぐ STEP 2 で作成中になる", () => {
    const state = run({ type: "survey_submitted" });
    expect(state).toMatchObject({ step: 2, generating: true, review: "" });
  });

  it("作成が終わったら、その場で文章を出す(待ち時間の状態を挟まない)", () => {
    const state = run(...generated());
    expect(state).toMatchObject({ step: 2, generating: false, review: "作成した文章", error: null });
  });

  it("1回目の作成に失敗したら、文章が無いまま STEP 2 でエラーを出し、作り直せる", () => {
    const failed = run({ type: "survey_submitted" }, { type: "generate_failed", error: "失敗" });
    expect(failed).toMatchObject({ step: 2, generating: false, review: "", error: "失敗" });
    const retried = flowReducer(failed, { type: "generate_started" });
    expect(retried).toMatchObject({ generating: true, error: null });
  });

  it("作り直しの間と、作り直しに失敗したときも、編集中の文章は残る", () => {
    const edited = run(...generated(), { type: "review_edited", review: "編集した文章" });
    const regenerating = flowReducer(edited, { type: "generate_started" });
    expect(regenerating).toMatchObject({ review: "編集した文章", generating: true });
    const failed = flowReducer(regenerating, { type: "generate_failed", error: "通信エラー" });
    expect(failed).toMatchObject({ review: "編集した文章", generating: false, error: "通信エラー", step: 2 });
  });

  it("コピーできたら STEP 3 へ進み、「コピーしました」の状態にする", () => {
    const state = run(...generated(), { type: "copy_succeeded" });
    expect(state).toMatchObject({ step: 3, copied: true, copyFailed: false });
  });

  it("コピーに失敗したら STEP 2 に残り、文章もそのまま。手動でコピーしたあと STEP 3 へ進める(コピーしましたにはしない)", () => {
    const failed = run(...generated(), { type: "review_edited", review: "編集した文章" }, { type: "copy_failed" });
    expect(failed).toMatchObject({ step: 2, copyFailed: true, review: "編集した文章" });
    const manual = flowReducer(failed, { type: "manual_copy_confirmed" });
    expect(manual).toMatchObject({ step: 3, copied: false, copyFailed: false, review: "編集した文章" });
  });

  it("コピーに失敗したあと、もう一度のコピーに成功すれば STEP 3 へ進む", () => {
    const state = run(...generated(), { type: "copy_failed" }, { type: "copy_succeeded" });
    expect(state).toMatchObject({ step: 3, copied: true, copyFailed: false });
  });

  it("STEP 3 から「文章を編集する」で STEP 2 に戻ると、文章は残り、編集してもう一度進める", () => {
    const back = run(...generated(), { type: "copy_succeeded" }, { type: "back_to_edit" });
    expect(back).toMatchObject({ step: 2, review: "作成した文章", copied: false });
    const reEdited = flowReducer(back, { type: "review_edited", review: "書き直した文章" });
    const again = flowReducer(reEdited, { type: "copy_succeeded" });
    expect(again).toMatchObject({ step: 3, copied: true, review: "書き直した文章" });
  });

  it("作成中・文章が無いときは、コピーや手動の進みで STEP 3 へ進まない", () => {
    const generating = run({ type: "survey_submitted" });
    expect(flowReducer(generating, { type: "copy_succeeded" }).step).toBe(2);
    expect(flowReducer(generating, { type: "manual_copy_confirmed" }).step).toBe(2);
    const regenerating = run(...generated(), { type: "generate_started" });
    expect(flowReducer(regenerating, { type: "copy_succeeded" }).step).toBe(2);
  });

  it("STEP 1 からは、コピーや戻るの操作で動かない", () => {
    for (const action of [{ type: "copy_succeeded" }, { type: "copy_failed" }, { type: "manual_copy_confirmed" }, { type: "back_to_edit" }] as FlowAction[]) {
      expect(flowReducer(INITIAL_FLOW_STATE, action)).toEqual(INITIAL_FLOW_STATE);
    }
  });
});

describe("作成中に出すもの", () => {
  it("1回目は、店舗の表示があれば showcase、無ければシンプルな skeleton", () => {
    const state = run({ type: "survey_submitted" });
    expect(generatingView(state, true)).toBe("showcase");
    expect(generatingView(state, false)).toBe("skeleton");
  });

  it("作り直しは、店舗の表示があっても出さず、今の文章を残したまま行の中で示す", () => {
    const state = run(...generated(), { type: "generate_started" });
    expect(generatingView(state, true)).toBe("inline");
    expect(generatingView(state, false)).toBe("inline");
  });

  it("作成が終わったら(完成後の画面では)何も出さない", () => {
    const state = run(...generated());
    expect(generatingView(state, true)).toBeNull();
  });
});
