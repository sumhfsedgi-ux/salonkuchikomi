import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GenerationShowcase from "@/components/review/GenerationShowcase";

const SHOWCASE = {
  imageUrl: "https://example.supabase.co/storage/v1/object/public/review-showcase/a/b.jpg",
  catchCopy: "忙しい毎日に、自分をいたわる時間を。",
};
const text = (html: string) => html.replace(/<[^>]+>/g, "");

function render(fitViewport?: boolean): string {
  return renderToStaticMarkup(createElement(GenerationShowcase, { showcase: SHOWCASE, salonName: "架空のサロン", fitViewport }));
}

describe("GenerationShowcase(口コミ作成中の店舗の表示)", () => {
  it("写真1枚・キャッチコピー・店名をまとめて出す", () => {
    const html = render();
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain(`src="${SHOWCASE.imageUrl}"`);
    expect(text(html)).toContain(SHOWCASE.catchCopy);
    expect(text(html)).toContain("架空のサロン");
  });

  it("写真の後ろに緑の背景、下半分に暗いグラデーションを敷き、コピーは2行までにする", () => {
    const html = render();
    expect(html).toContain("from-sage-dark");
    expect(html).toContain("bg-gradient-to-t from-black/70");
    expect(html).toContain("line-clamp-2");
  });

  it("見出し・説明・「作成しています」の文字・リンク・ボタン・動画は出さない", () => {
    const html = render();
    const t = text(html);
    expect(t).not.toContain("作成しています");
    expect(t).not.toContain("お知らせ");
    expect(html).not.toMatch(/<(a|button|video|h1|h2|h3)\b/);
    expect(t.trim()).toBe(`架空のサロン${SHOWCASE.catchCopy}`);
  });

  it("小さな読み込み中の表示を写真の下に置く(読み上げには出さない)", () => {
    const html = render();
    expect(html).toMatch(/<\/div><span aria-hidden="true" class="[^"]*animate-spin[^"]*"><\/span><\/div>$/);
  });

  it("お客様ページでは画面の高さに収め、管理画面のプレビューでは収めない", () => {
    expect(render()).toContain("max-h-[62dvh]");
    expect(render(false)).not.toContain("max-h-[62dvh]");
  });
});
