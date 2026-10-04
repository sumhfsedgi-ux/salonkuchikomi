import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GeneratedReview from "@/components/review/GeneratedReview";

const GOOGLE_URL = "https://g.page/r/example/review";

function render(review: string): string {
  return renderToStaticMarkup(
    createElement(GeneratedReview, {
      review,
      onReviewChange: () => {},
      onCopy: () => {},
      googleReviewUrl: GOOGLE_URL,
    }),
  );
}

// review gating の禁止: 回答の内容にかかわらず、全員に同じ導線を出す。
describe("GeneratedReview の Google口コミへの導線", () => {
  it.each([
    ["肯定的な下書き", "説明が分かりやすくて、施術のあとは肌がなめらかに感じました。"],
    ["否定的な下書き", "待ち時間が長かったのが残念でした。説明も少し分かりにくかったです。"],
    ["空の下書き", ""],
  ])("%sでも同じ CTA を表示する", (_label, review) => {
    const html = render(review);
    expect(html).toContain("内容を確認してGoogleに投稿する");
    expect(html).toContain(`href="${GOOGLE_URL}"`);
  });

  it("投稿前に本人が確認・編集する案内を表示する(チェックボックスは無い)", () => {
    const html = render("下書き");
    expect(html).toContain("実際の体験と異なる部分があれば編集してください");
    expect(html).not.toContain('type="checkbox"');
  });
});
