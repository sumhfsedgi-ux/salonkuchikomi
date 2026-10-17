import { describe, expect, it, vi } from "vitest";
import { catchCopyError, catchCopyLength, enableError, normalizeCatchCopy } from "@/lib/reviewShowcase/settings";
import { checkShowcaseImage, detectImageType } from "@/lib/reviewShowcase/image";
import { buildShowcaseImagePath, isShowcaseImagePathOf, showcaseImageUrl } from "@/lib/reviewShowcase/storage";
import { loadPublicShowcase, loadShowcase, showcaseSettingsFromRow } from "@/lib/reviewShowcase/repo";

const SALON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OBJECT = "33333333-3333-4333-8333-333333333333";
const PATH = `${SALON}/${OBJECT}.jpg`;

describe("キャッチコピー", () => {
  it("前後の空白を除き、30文字まで(絵文字も1文字)・改行なし", () => {
    expect(normalizeCatchCopy("  サロンのあとも、心地よい毎日へ。 ")).toBe("サロンのあとも、心地よい毎日へ。");
    expect(catchCopyLength("🌿癒し")).toBe(3);
    expect(catchCopyError("あ".repeat(30))).toBeNull();
    expect(catchCopyError("あ".repeat(31))).toContain("30文字以内");
    expect(catchCopyError("一行目\n二行目")).toContain("改行");
  });

  it("有効にするには写真とコピーの両方が必要", () => {
    expect(enableError({ hasImage: true, catchCopy: "コピー" })).toBeNull();
    expect(enableError({ hasImage: false, catchCopy: "コピー" })).toContain("写真");
    expect(enableError({ hasImage: true, catchCopy: "" })).toContain("キャッチコピー");
    expect(enableError({ hasImage: false, catchCopy: "" })).toContain("写真とキャッチコピー");
  });
});

describe("写真の形式", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");

  it("先頭のバイトで JPEG・PNG・WebP を見分け、それ以外は受け付けない", () => {
    expect(detectImageType(jpeg)).toBe("image/jpeg");
    expect(detectImageType(png)).toBe("image/png");
    expect(detectImageType(webp)).toBe("image/webp");
    expect(detectImageType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(detectImageType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(checkShowcaseImage(new TextEncoder().encode("<html>"))).toMatchObject({ ok: false });
  });

  it("空・1MB を超える写真は受け付けない", () => {
    expect(checkShowcaseImage(new Uint8Array())).toMatchObject({ ok: false });
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(jpeg);
    expect(checkShowcaseImage(big)).toMatchObject({ ok: false, error: expect.stringContaining("大きすぎ") });
    const fits = new Uint8Array(1024 * 1024);
    fits.set(jpeg);
    expect(checkShowcaseImage(fits)).toEqual({ ok: true, type: "image/jpeg" });
  });
});

describe("写真の置き場所", () => {
  it("パスは <salon_id>/<uuid>.<拡張子> で、その店舗のものだけを認める", () => {
    expect(buildShowcaseImagePath(SALON, OBJECT, "image/webp")).toBe(`${SALON}/${OBJECT}.webp`);
    expect(isShowcaseImagePathOf(SALON, PATH)).toBe(true);
    expect(isShowcaseImagePathOf(OTHER, PATH)).toBe(false);
    expect(isShowcaseImagePathOf(SALON, `${SALON}/../${OBJECT}.jpg`)).toBe(false);
    expect(isShowcaseImagePathOf(SALON, `${SALON}/${OBJECT}.svg`)).toBe(false);
  });

  it("公開 URL は Storage の public のバケット(Supabase の URL が無ければ null)", () => {
    expect(showcaseImageUrl(PATH, "https://abc.supabase.co/")).toBe(
      `https://abc.supabase.co/storage/v1/object/public/review-showcase/${PATH}`,
    );
    expect(showcaseImageUrl(PATH, "")).toBeNull();
  });
});

function fakeClient(result: { data: unknown; error: { code?: string } | null }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const query = {
    select: (...a: unknown[]) => (calls.push(["select", ...a]), query),
    eq: (...a: unknown[]) => (calls.push(["eq", ...a]), query),
    maybeSingle: async () => result,
  };
  return {
    calls,
    client: { from: (table: string) => (calls.push(["from", table]), query) } as never,
  };
}

describe("読み込み", () => {
  it("管理画面: 行が無ければ未設定(保存はできる)、表が無い・失敗なら保存できない扱い", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadShowcase(fakeClient({ data: null, error: null }).client, SALON)).toEqual({ row: null, storageAvailable: true });
    expect(await loadShowcase(fakeClient({ data: null, error: { code: "PGRST205" } }).client, SALON)).toEqual({
      row: null,
      storageAvailable: false,
    });
    expect(showcaseSettingsFromRow(null)).toEqual({ enabled: false, catchCopy: "", imageUrl: null });
  });

  it("管理画面: その店舗の salon_id で読み、他店舗のパスは写真として使わない", async () => {
    const fake = fakeClient({ data: { enabled: false, catch_copy: "コピー", image_path: `${OTHER}/${OBJECT}.jpg` }, error: null });
    const loaded = await loadShowcase(fake.client, SALON);
    expect(fake.calls).toContainEqual(["eq", "salon_id", SALON]);
    expect(loaded.row).toEqual({ enabled: false, catchCopy: "コピー", imagePath: null });
  });

  it("お客様ページ: 公開用のビューを読み、写真の URL とコピーだけを返す", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const fake = fakeClient({ data: { catch_copy: "コピー", image_path: PATH }, error: null });
    expect(await loadPublicShowcase(fake.client, SALON)).toEqual({
      imageUrl: `https://abc.supabase.co/storage/v1/object/public/review-showcase/${PATH}`,
      catchCopy: "コピー",
    });
    expect(fake.calls[0]).toEqual(["from", "review_showcase_public"]);
    expect(fake.calls).toContainEqual(["eq", "salon_id", SALON]);
    vi.unstubAllEnvs();
  });

  it("お客様ページ: 行が無い・失敗・形の違うパスなら null(シンプルな表示になる)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    expect(await loadPublicShowcase(fakeClient({ data: null, error: null }).client, SALON)).toBeNull();
    expect(await loadPublicShowcase(fakeClient({ data: null, error: { code: "42P01" } }).client, SALON)).toBeNull();
    expect(
      await loadPublicShowcase(fakeClient({ data: { catch_copy: "コピー", image_path: `${OTHER}/${OBJECT}.jpg` }, error: null }).client, SALON),
    ).toBeNull();
    expect(await loadPublicShowcase(fakeClient({ data: { catch_copy: " ", image_path: PATH }, error: null }).client, SALON)).toBeNull();
    vi.unstubAllEnvs();
  });
});
