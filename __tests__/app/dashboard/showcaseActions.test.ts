import { beforeEach, describe, expect, it, vi } from "vitest";

// 口コミ作成中の表示の保存(app/dashboard/reviews/showcaseActions.ts)。DB・Storage には接続しない
// (店舗の解決・service role のクライアント・読み書きを差し替える)。

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ fake: "session" })) }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => ({ fake: "admin" })) }));
vi.mock("@/lib/access/featureAccess", () => ({ resolveFeatureSalon: vi.fn() }));
vi.mock("@/lib/reviewShowcase/repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewShowcase/repo")>()),
  loadShowcase: vi.fn(),
  saveShowcaseRow: vi.fn(async () => "saved"),
  uploadShowcaseImage: vi.fn(async () => true),
  removeShowcaseImages: vi.fn(async () => {}),
}));

const { saveReviewShowcaseAction } = await import("@/app/dashboard/reviews/showcaseActions");
const { resolveFeatureSalon } = await import("@/lib/access/featureAccess");
const { loadShowcase, saveShowcaseRow, uploadShowcaseImage, removeShowcaseImages } = await import("@/lib/reviewShowcase/repo");
const { revalidatePath } = await import("next/cache");

const MY_SALON = "11111111-1111-4111-8111-111111111111";
const OTHER_SALON = "22222222-2222-4222-8222-222222222222";
const OLD_PATH = `${MY_SALON}/33333333-3333-4333-8333-333333333333.jpg`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function form(values: Record<string, string | Blob>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}
const jpegFile = () => new File([JPEG], "photo.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.mocked(resolveFeatureSalon).mockResolvedValue({ ok: true, salon: { id: MY_SALON } as never, userId: "user-1" });
  vi.mocked(loadShowcase).mockResolvedValue({ row: null, storageAvailable: true });
  vi.mocked(saveShowcaseRow).mockResolvedValue("saved");
  vi.mocked(uploadShowcaseImage).mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("saveReviewShowcaseAction", () => {
  it("口コミを使えない(ログインしていない・権限が無い)ときは、何も読まず書かない", async () => {
    vi.mocked(resolveFeatureSalon).mockResolvedValue({ ok: false, error: "この機能は利用できません。" });
    const result = await saveReviewShowcaseAction(form({ enabled: "1", catch_copy: "コピー", image: jpegFile() }));
    expect(result).toEqual({ ok: false, error: "この機能は利用できません。" });
    expect(resolveFeatureSalon).toHaveBeenCalledWith({ fake: "session" }, "reviews");
    expect(loadShowcase).not.toHaveBeenCalled();
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
    expect(saveShowcaseRow).not.toHaveBeenCalled();
  });

  it("フォームに他店舗の salon_id があっても、ログイン中の店舗だけを読み書きする", async () => {
    const result = await saveReviewShowcaseAction(
      form({ salon_id: OTHER_SALON, salonId: OTHER_SALON, enabled: "1", catch_copy: "コピー", image: jpegFile() }),
    );
    expect(result.ok).toBe(true);
    expect(vi.mocked(loadShowcase).mock.calls[0][1]).toBe(MY_SALON);
    const [, uploadPath] = vi.mocked(uploadShowcaseImage).mock.calls[0];
    expect(uploadPath).toMatch(new RegExp(`^${MY_SALON}/[0-9a-f-]{36}\\.jpg$`));
    expect(vi.mocked(saveShowcaseRow).mock.calls[0][1]).toBe(MY_SALON);
    expect(JSON.stringify(vi.mocked(saveShowcaseRow).mock.calls)).not.toContain(OTHER_SALON);
  });

  it("新しい写真で有効にする: 写真を置いてから行を保存し、公開の画面を作り直す", async () => {
    const result = await saveReviewShowcaseAction(form({ enabled: "1", catch_copy: "  忙しい毎日に、自分をいたわる時間を。 ", image: jpegFile() }));
    expect(result).toMatchObject({
      ok: true,
      settings: { enabled: true, catchCopy: "忙しい毎日に、自分をいたわる時間を。", imageUrl: expect.stringContaining("/review-showcase/") },
    });
    const [, path, bytes, type] = vi.mocked(uploadShowcaseImage).mock.calls[0];
    expect(Array.from(bytes)).toEqual(Array.from(JPEG));
    expect(type).toBe("image/jpeg");
    expect(vi.mocked(saveShowcaseRow).mock.calls[0][2]).toEqual({ enabled: true, catchCopy: "忙しい毎日に、自分をいたわる時間を。", imagePath: path });
    expect(vi.mocked(uploadShowcaseImage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(saveShowcaseRow).mock.invocationCallOrder[0]);
    expect(removeShowcaseImages).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/review/[slug]", "page");
  });

  it("写真を変える: 行の保存のあとで、古い写真を消す", async () => {
    vi.mocked(loadShowcase).mockResolvedValue({ row: { enabled: true, catchCopy: "コピー", imagePath: OLD_PATH }, storageAvailable: true });
    await saveReviewShowcaseAction(form({ enabled: "1", catch_copy: "コピー", image: jpegFile() }));
    const newPath = vi.mocked(uploadShowcaseImage).mock.calls[0][1];
    expect(newPath).not.toBe(OLD_PATH);
    expect(removeShowcaseImages).toHaveBeenCalledWith({ fake: "admin" }, [OLD_PATH]);
    expect(vi.mocked(saveShowcaseRow).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(removeShowcaseImages).mock.invocationCallOrder[0]);
  });

  it("写真を削除する: パスを外して無効で保存し、写真を消す", async () => {
    vi.mocked(loadShowcase).mockResolvedValue({ row: { enabled: true, catchCopy: "コピー", imagePath: OLD_PATH }, storageAvailable: true });
    const result = await saveReviewShowcaseAction(form({ enabled: "0", catch_copy: "コピー", remove_image: "1" }));
    expect(result).toMatchObject({ ok: true, settings: { enabled: false, imageUrl: null } });
    expect(vi.mocked(saveShowcaseRow).mock.calls[0][2]).toEqual({ enabled: false, catchCopy: "コピー", imagePath: null });
    expect(removeShowcaseImages).toHaveBeenCalledWith({ fake: "admin" }, [OLD_PATH]);
  });

  it("無効にする: 写真はそのまま残す", async () => {
    vi.mocked(loadShowcase).mockResolvedValue({ row: { enabled: true, catchCopy: "コピー", imagePath: OLD_PATH }, storageAvailable: true });
    const result = await saveReviewShowcaseAction(form({ enabled: "0", catch_copy: "コピー" }));
    expect(result).toMatchObject({ ok: true, settings: { enabled: false } });
    expect(vi.mocked(saveShowcaseRow).mock.calls[0][2]).toEqual({ enabled: false, catchCopy: "コピー", imagePath: OLD_PATH });
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
    expect(removeShowcaseImages).not.toHaveBeenCalled();
  });

  it("写真かコピーが無いのに有効にしようとしたら、何も置かず保存しない", async () => {
    const cases: Array<Record<string, string | Blob>> = [
      { enabled: "1", catch_copy: "コピー" },
      { enabled: "1", catch_copy: "", image: jpegFile() },
    ];
    for (const values of cases) {
      const result = await saveReviewShowcaseAction(form(values));
      expect(result.ok).toBe(false);
    }
    vi.mocked(loadShowcase).mockResolvedValue({ row: { enabled: true, catchCopy: "コピー", imagePath: OLD_PATH }, storageAvailable: true });
    expect((await saveReviewShowcaseAction(form({ enabled: "1", catch_copy: "コピー", remove_image: "1" }))).ok).toBe(false);
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
    expect(saveShowcaseRow).not.toHaveBeenCalled();
  });

  it("写真ではないファイル・長すぎるコピーは受け付けない", async () => {
    const svg = new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "a.jpg", { type: "image/jpeg" });
    expect(await saveReviewShowcaseAction(form({ enabled: "0", catch_copy: "", image: svg }))).toMatchObject({ ok: false });
    expect(await saveReviewShowcaseAction(form({ enabled: "0", catch_copy: "あ".repeat(31) }))).toMatchObject({ ok: false });
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
    expect(saveShowcaseRow).not.toHaveBeenCalled();
  });

  it("行の保存に失敗したら、置いた新しい写真を消し、古い写真は残す", async () => {
    vi.mocked(loadShowcase).mockResolvedValue({ row: { enabled: false, catchCopy: "", imagePath: OLD_PATH }, storageAvailable: true });
    vi.mocked(saveShowcaseRow).mockResolvedValue("failed");
    const result = await saveReviewShowcaseAction(form({ enabled: "0", catch_copy: "", image: jpegFile() }));
    expect(result.ok).toBe(false);
    const newPath = vi.mocked(uploadShowcaseImage).mock.calls[0][1];
    expect(removeShowcaseImages).toHaveBeenCalledTimes(1);
    expect(removeShowcaseImages).toHaveBeenCalledWith({ fake: "admin" }, [newPath]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("写真を置けなかったら、行は保存しない", async () => {
    vi.mocked(uploadShowcaseImage).mockResolvedValue(false);
    const result = await saveReviewShowcaseAction(form({ enabled: "1", catch_copy: "コピー", image: jpegFile() }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("写真を保存できませんでした") });
    expect(saveShowcaseRow).not.toHaveBeenCalled();
  });

  it("0033 の適用前(表が無い)は、準備中として何も置かない", async () => {
    vi.mocked(loadShowcase).mockResolvedValue({ row: null, storageAvailable: false });
    const result = await saveReviewShowcaseAction(form({ enabled: "1", catch_copy: "コピー", image: jpegFile() }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("準備中") });
    expect(uploadShowcaseImage).not.toHaveBeenCalled();
  });
});
