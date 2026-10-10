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
      onRegenerate: () => {},
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
  ])("%sでも、コピーして進む導線と自分で書く導線の両方を同じ Google の URL で表示する", (_label, review) => {
    const html = render(review);
    expect(html.replace(/<[^>]+>/g, "")).toContain("この口コミをコピーしてGoogleレビューへ進む");
    expect(html).toContain("自分で文章を考えて投稿する");
    expect(html.split(`href="${GOOGLE_URL}"`).length - 1).toBe(2);
    expect(html).toContain("もう一度作成する");
  });

  it("文章案の画面の見出しと、投稿前に本人が確認・編集する案内、自動で投稿されないことを表示する(チェックボックスは無い)", () => {
    const html = render("下書き");
    expect(html).toContain("アンケートの回答をもとに");
    expect(html).toContain("口コミの文章案を作成しました");
    expect(html).toContain("内容を確認して、実際の体験と違うところがあれば自由に編集してください。");
    expect(html).toContain("自動で投稿されることはありません");
    expect(html).not.toContain('type="checkbox"');
  });
});
