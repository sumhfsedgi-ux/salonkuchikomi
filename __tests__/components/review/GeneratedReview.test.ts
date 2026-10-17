import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GeneratedReview from "@/components/review/GeneratedReview";

const GOOGLE_URL = "https://g.page/r/example/review";

function render(review: string, extra: { copyFailed?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(GeneratedReview, {
      review,
      onReviewChange: () => {},
      onCopy: () => {},
      onRegenerate: () => {},
      googleReviewUrl: GOOGLE_URL,
      ...extra,
    }),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, "");

// review gating の禁止: 回答の内容にかかわらず、全員に同じ導線を出す。
describe("GeneratedReview の Google口コミへの導線", () => {
  it.each([
    ["肯定的な下書き", "説明が分かりやすくて、施術のあとは肌がなめらかに感じました。"],
    ["否定的な下書き", "待ち時間が長かったのが残念でした。説明も少し分かりにくかったです。"],
    ["空の下書き", ""],
  ])("%sでも、コピーして進むボタンと、自分で書く導線(Google への通常のリンク)の両方を出す", (_label, review) => {
    const html = render(review);
    expect(html).toMatch(/<button type="button" class="btn-primary">口コミをコピーして進む<\/button>/);
    expect(html).toContain("自分で文章を考えて投稿する");
    // Google へのリンクは「自分で書く」の1つだけ(コピーのボタンでは Google を開かない)。
    expect(html.split(`href="${GOOGLE_URL}"`).length - 1).toBe(1);
    expect(html).toMatch(/<a href="https:\/\/g\.page\/r\/example\/review" target="_blank" rel="noopener noreferrer"[^>]*>自分で文章を考えて投稿する<\/a>/);
    expect(html).toContain("もう一度作成する");
  });

  it("肯定的・否定的な下書きで、文章の欄のほかは同じ画面になる", () => {
    const strip = (html: string) => html.replace(/<textarea[\s\S]*?<\/textarea>/, "").replace(/\d+文字/, "");
    expect(strip(render("とても良かったです。"))).toBe(strip(render("残念でした。")));
  });

  it("見出し・投稿のお願い・編集の案内・自動で投稿されないことを出す(チェックボックスは無い)", () => {
    const html = text(render("下書き"));
    expect(html).toContain("ご協力ありがとうございます。");
    expect(html).toContain("ご回答をもとに、口コミ文章を作成しました。");
    expect(html).toContain("よろしければ、口コミの投稿もご協力いただけますと幸いです。");
    expect(html).toContain("内容を確認して、実際の体験と違うところがあれば自由に編集してください。");
    expect(html).toContain("自動で投稿されることはありません");
    expect(render("下書き")).not.toContain('type="checkbox"');
    expect(html).not.toContain("口コミの文章案を作成しました");
  });

  it("コピーに失敗したあとは、手動でコピーする案内・もう一度コピー・そのまま進むボタンを出し、「コピーしました」は出さない", () => {
    const html = render("下書き", { copyFailed: true });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("コピーできませんでした。");
    expect(text(html)).toContain("Ctrl+C／⌘+C");
    expect(text(html)).toContain("もう一度コピーする");
    expect(text(html)).toContain("コピーできたので次へ進む");
    expect(text(html)).not.toContain("コピーしました");
    // 失敗の案内を出しても、自分で書く導線は残る。
    expect(html.split(`href="${GOOGLE_URL}"`).length - 1).toBe(1);
  });

  it("コピーに失敗していなければ、失敗の案内は出さない", () => {
    const html = render("下書き");
    expect(html).not.toContain('role="alert"');
    expect(text(html)).not.toContain("コピーできたので次へ進む");
  });
});
