import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PostingGuide from "@/components/review/PostingGuide";

const GOOGLE_URL = "https://g.page/r/example/review";
const text = (html: string) => html.replace(/<[^>]+>/g, "");

function render(copied: boolean): string {
  return renderToStaticMarkup(
    createElement(PostingGuide, { copied, googleReviewUrl: GOOGLE_URL, onOpenGoogle: () => {}, onBack: () => {} }),
  );
}

describe("PostingGuide(STEP 3 投稿のご案内)", () => {
  it("コピーできて進んだときは「口コミをコピーしました」、手動でコピーして進んだときは「投稿のご案内」を見出しにする", () => {
    expect(text(render(true))).toContain("口コミをコピーしました");
    expect(text(render(false))).not.toContain("口コミをコピーしました");
    expect(text(render(false))).toContain("投稿のご案内");
  });

  it("Google の投稿画面での3つの手順を、番号付きで順に出す(パソコンの貼り付け方も補う)", () => {
    const t = text(render(true));
    expect(t).toContain("Googleの投稿画面で、次の操作をお願いします。");
    const order = ["星で評価する", "ご自身の体験に合った評価を選んでください。", "口コミを貼り付ける", "文章の入力欄を長押しして『貼り付け』を選んでください。", "Ctrl+V（Macは ⌘+V）", "内容を確認して投稿する"];
    let last = -1;
    for (const part of order) {
      const at = t.indexOf(part);
      expect(at, part).toBeGreaterThan(last);
      last = at;
    }
    expect(render(true).match(/<li /g)).toHaveLength(3);
  });

  it("Google は主ボタンの通常のリンク(新しいタブ)で開き、ログインの補足と「文章を編集する」を出す", () => {
    const html = render(true);
    expect(html).toMatch(
      /<a href="https:\/\/g\.page\/r\/example\/review" target="_blank" rel="noopener noreferrer" class="btn-primary[^"]*">Googleの投稿画面を開く<\/a>/,
    );
    expect(html.split(`href="${GOOGLE_URL}"`).length - 1).toBe(1);
    expect(text(html)).toContain("Googleアカウントへのログインが必要な場合があります。");
    expect(html).toMatch(/<button type="button"[^>]*>文章を編集する<\/button>/);
  });

  it("投稿の完了は扱わない(完了・ありがとうの表示や、星の数で導線を変える要素は無い)", () => {
    const t = text(render(true));
    expect(t).not.toContain("投稿が完了");
    expect(t).not.toContain("投稿しました");
    expect(render(true)).not.toContain('type="checkbox"');
  });
});
