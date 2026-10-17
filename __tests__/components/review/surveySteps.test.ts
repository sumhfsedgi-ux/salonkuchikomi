import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReviewHeader from "@/components/review/ReviewHeader";
import StepIndicator from "@/components/review/StepIndicator";
import SurveyForm from "@/components/review/SurveyForm";

const LABELS = { 1: "回答", 2: "文章の確認", 3: "投稿のご案内" } as const;
const text = (html: string) => html.replace(/<[^>]+>/g, "");

function renderSurveyForm(): string {
  return renderToStaticMarkup(
    createElement(SurveyForm, {
      questions: [
        { id: "q1", question: "ご来店のきっかけ", required: true, sortOrder: 1, type: "single", options: ["紹介", "その他"] },
      ],
      answers: { q1: "" },
      onAnswersChange: () => {},
      otherDetails: {},
      onOtherDetailsChange: () => {},
      onSubmit: () => {},
      loading: false,
      hideCta: false,
    }),
  );
}

describe("お客様ページの STEP 1", () => {
  it.each([1, 2, 3] as const)("ヘッダーに店名・お客様アンケート・ステップ(STEP %i が今)を出し、説明文は出さない", (step) => {
    const html = renderToStaticMarkup(createElement(ReviewHeader, { salonName: "Lavi Aromatic Herb", step }));
    expect(html).toContain("Lavi Aromatic Herb");
    expect(html).toContain("お客様アンケート");
    expect(html).toContain('aria-label="進み具合"');
    expect(html).toContain(`aria-current="step" aria-label="STEP ${step} ${LABELS[step]}"`);
    expect(html).not.toContain("対象としています");
    expect(html).not.toContain("サービス改善");
  });

  it("最初の質問の前に、対象のお客様と率直な感想のお願いの案内を出す(チェックボックス・任意の投稿の文は無い)", () => {
    const html = renderSurveyForm();
    const intro =
      "このアンケートは、当店をご利用いただいたお客様を対象としています。実際に体験されたことや、率直なご感想をお聞かせください。";
    expect(text(html)).toContain(intro);
    expect(text(html).indexOf(intro)).toBeLessThan(text(html).indexOf("ご来店のきっかけ"));
    expect(html).not.toContain('type="checkbox"');
    expect(text(html)).not.toContain("口コミの投稿は任意です");
    expect(text(html)).not.toContain("ご回答をもとに口コミの文章案を作成します");
    // 警告の見た目(赤・黄の枠)にはしない。
    expect(html).not.toMatch(/<p class="[^"]*(red|warning|amber|yellow)[^"]*">このアンケートは/);
  });

  it("回答のボタンと、Google に投稿されない注意書きを表示する", () => {
    const html = renderSurveyForm();
    expect(html).toContain("アンケートに回答する");
    expect(html).toContain("※この操作でGoogleに投稿されることはありません");
  });
});

describe("StepIndicator", () => {
  it.each([1, 2, 3] as const)("STEP %i を今のステップとして示す", (current) => {
    const html = renderToStaticMarkup(createElement(StepIndicator, { current }));
    const items = html.match(/<li[^>]*aria-current="step"[^>]*>[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toContain(`>${current}<`);
    expect(items[0]).toContain(`>${LABELS[current]}<`);
  });

  it("回答 → 文章の確認 → 投稿のご案内 の3段階を、この順で出す", () => {
    const t = text(renderToStaticMarkup(createElement(StepIndicator, { current: 1 })));
    expect(t).toBe("1回答2文章の確認3投稿のご案内");
  });

  it("終わったステップも緑で塗る(今より後のステップは塗らない)", () => {
    const filled = (current: 1 | 2 | 3) =>
      (renderToStaticMarkup(createElement(StepIndicator, { current })).match(/bg-sage text-white/g) ?? []).length;
    expect(filled(1)).toBe(1);
    expect(filled(2)).toBe(2);
    expect(filled(3)).toBe(3);
  });
});
