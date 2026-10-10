import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Hero from "@/components/review/Hero";
import StepIndicator from "@/components/review/StepIndicator";
import SurveyForm from "@/components/review/SurveyForm";

describe("お客様ページの STEP 1", () => {
  it("店名・お客様アンケート・対象と活用の説明を表示する(文章案を作る旨の一文は入れない)", () => {
    const html = renderToStaticMarkup(createElement(Hero, { salonName: "Lavi Aromatic Herb" }));
    expect(html).toContain("Lavi Aromatic Herb");
    expect(html).toContain("お客様アンケート");
    expect(html).toContain("このアンケートは当店をご利用いただいた方を対象としています。");
    expect(html).toContain("アンケートに回答することで得られるデータは、当店のサービス改善に活用させていただきます。");
    expect(html).not.toContain("口コミの文章案をお作りします");
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
});
