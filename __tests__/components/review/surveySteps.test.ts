import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReviewHeader from "@/components/review/ReviewHeader";
import StepIndicator from "@/components/review/StepIndicator";
import SurveyForm from "@/components/review/SurveyForm";

describe("お客様ページの STEP 1", () => {
  it.each([1, 2] as const)("ヘッダーに店名・お客様アンケート・ステップ(STEP %i が今)を出し、説明文は出さない", (step) => {
    const html = renderToStaticMarkup(createElement(ReviewHeader, { salonName: "Lavi Aromatic Herb", step }));
    expect(html).toContain("Lavi Aromatic Herb");
    expect(html).toContain("お客様アンケート");
    expect(html).toContain('aria-label="進み具合"');
    expect(html).toContain(`aria-current="step" aria-label="STEP ${step}"`);
    expect(html).not.toContain("対象としています");
    expect(html).not.toContain("サービス改善");
  });

  it("回答のボタンと、Google に投稿されない注意書きを表示する", () => {
    const html = renderToStaticMarkup(
      createElement(SurveyForm, {
        questions: [],
        answers: {},
        onAnswersChange: () => {},
        otherDetails: {},
        onOtherDetailsChange: () => {},
        onSubmit: () => {},
        loading: false,
        hideCta: false,
      }),
    );
    expect(html).toContain("アンケートに回答する");
    expect(html).toContain("※この操作でGoogleに投稿されることはありません");
  });
});

describe("StepIndicator", () => {
  it.each([1, 2] as const)("STEP %i を今のステップとして示す", (current) => {
    const html = renderToStaticMarkup(createElement(StepIndicator, { current }));
    const items = html.match(/<li[^>]*aria-current="step"[^>]*>[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toContain(`>${current}<`);
  });

  it("丸の下に文字を出さない", () => {
    const html = renderToStaticMarkup(createElement(StepIndicator, { current: 1 }));
    expect(html).not.toContain("アンケート");
    expect(html).not.toContain("口コミ文章案");
  });

  it("STEP 2 では、終わった STEP 1 も緑で塗る(STEP 1 では STEP 2 は塗らない)", () => {
    const filled = (current: 1 | 2) =>
      (renderToStaticMarkup(createElement(StepIndicator, { current })).match(/bg-sage text-white/g) ?? []).length;
    expect(filled(1)).toBe(1);
    expect(filled(2)).toBe(2);
  });
});
