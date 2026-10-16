import { describe, expect, it } from "vitest";
import { classifyForbidden, createGbpHttpApiClient, errorKind, GbpApiError } from "@/lib/gbp/apiClient";
import { toCachedReview } from "@/lib/gbp/mapping";
import { replyHash, normalizeReplyText } from "@/lib/gbp/replyText";
import { reviewKeyFor, ReviewKeyConfigError } from "@/lib/gbp/reviewKey";
import { maskContactDetails, MASKED_CONTACT } from "@/lib/replyGeneration/text";
import { replyBucket, replyDisplayState, REPLY_STATE_VIEW } from "@/lib/googleReviews/replyState";
import { DEFAULT_LIST_QUERY, listQueryString, parseListQuery } from "@/lib/googleReviews/query";
import type { ReplyOperationState, ReviewSummary } from "@/lib/googleReviews/types";

const SECRET = "unit-test-review-key-secret-000000000000";

describe("403 の分類(計画 第2版 §3-B)", () => {
  const body = (status: string, reasons: string[], via: "details" | "errors" = "details") => ({
    error: { code: 403, status, [via]: reasons.map((reason) => ({ reason })) },
  });

  it("権限不足は、エラーの詳細の理由か WWW-Authenticate の insufficient_scope のときだけ", () => {
    expect(classifyForbidden(body("PERMISSION_DENIED", ["ACCESS_TOKEN_SCOPE_INSUFFICIENT"]), null)).toBe("scope_insufficient");
    expect(classifyForbidden(body("PERMISSION_DENIED", ["insufficientPermissions"], "errors"), null)).toBe("scope_insufficient");
    expect(classifyForbidden(null, 'Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="x"')).toBe("scope_insufficient");
  });

  it("API が有効でない・店舗の権限が無い・原因不明を分ける(権限不足にしない)", () => {
    expect(classifyForbidden(body("PERMISSION_DENIED", ["SERVICE_DISABLED"]), null)).toBe("service_disabled");
    expect(classifyForbidden(body("PERMISSION_DENIED", ["accessNotConfigured"], "errors"), null)).toBe("service_disabled");
    expect(classifyForbidden(body("PERMISSION_DENIED", []), null)).toBe("permission_denied");
    expect(classifyForbidden(null, null)).toBe("forbidden");
    expect(classifyForbidden({ error: "something" }, 'Bearer error="invalid_token"')).toBe("forbidden");
  });

  it("ほかの状態の分類", () => {
    expect(errorKind(401, null)).toBe("unauthorized");
    expect(errorKind(404, null)).toBe("not_found");
    expect(errorKind(429, null)).toBe("rate_limited");
    expect(errorKind(503, null)).toBe("unavailable");
    expect(errorKind(400, { error: { status: "FAILED_PRECONDITION" } })).toBe("failed_precondition");
    expect(errorKind(400, { error: { status: "INVALID_ARGUMENT" } })).toBe("invalid_argument");
    expect(errorKind(400, null)).toBe("bad_response");
  });

  it("HTTP の応答の WWW-Authenticate を分類に使う(本物の呼び出しの部品)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope"' },
      })) as unknown as typeof fetch;
    const api = createGbpHttpApiClient({ fetchImpl });
    await expect(api.listAccounts("t")).rejects.toMatchObject(new GbpApiError("scope_insufficient"));
  });
});

describe("口コミの API のエラーの見分け", () => {
  it("別のまとまりで作られた同じ名前・種類のエラーも、口コミの API のエラーとして分類する(拒否を結果不明にしない)", async () => {
    const { GbpApiError, isGbpApiError } = await import("@/lib/gbp/apiClient");
    // 開発サーバーで、同じクラスが別のまとまりに読み込まれた場合と同じ形
    class OtherCopy extends Error {
      constructor(readonly kind: string) {
        super(`gbp api: ${kind}`);
        this.name = "GbpApiError";
      }
    }
    expect(isGbpApiError(new GbpApiError("permission_denied"))).toBe(true);
    expect(isGbpApiError(new OtherCopy("permission_denied"))).toBe(true);
    expect(isGbpApiError(new OtherCopy("drop_table"))).toBe(false);
    expect(isGbpApiError(new Error("gbp api: timeout"))).toBe(false);
    expect(isGbpApiError({ name: "GbpApiError", kind: "timeout" })).toBe(false);
  });
});

describe("AI に送る前の伏せ字(§3-6)", () => {
  it("URL・メールアドレス・電話番号を伏せる。人名・ふつうの文はそのまま", () => {
    const text = "山田さんに担当してもらいました。予約は 03-1234-5678 か ０９０－１２３４－５６７８、info@example.com、https://example.com/x まで。";
    const masked = maskContactDetails(text);
    expect(masked).not.toMatch(/03-1234-5678|０９０|example\.com/);
    expect(masked.split(MASKED_CONTACT).length - 1).toBe(4);
    expect(masked).toContain("山田さんに担当してもらいました。");
    expect(maskContactDetails("2時間ほどで仕上がりました。")).toBe("2時間ほどで仕上がりました。");
  });
});

describe("返信の状態(§2「未返信」と「結果不明」を分ける)", () => {
  const review = (operation: ReplyOperationState, reply: ReviewSummary["reply"]) => ({ operation, reply });
  const reply = (state: "PENDING" | "APPROVED" | "REJECTED" | "UNSPECIFIED") => ({ comment: "返信", updateTime: "2026-10-15T00:00:00Z", state, policyViolation: null });

  it.each([
    ["sending", null, "sending", "attention"],
    ["unknown", null, "unconfirmed", "attention"],
    ["sent_checking", reply("PENDING"), "checking", "attention"],
    ["send_failed", null, "send_failed", "unreplied"],
    ["replace_failed", reply("APPROVED"), "replace_failed", "attention"],
    ["delete_failed", reply("APPROVED"), "delete_failed", "attention"],
    ["none", reply("REJECTED"), "rejected", "attention"],
    ["none", reply("PENDING"), "pending", "replied"],
    ["none", reply("APPROVED"), "approved", "replied"],
    ["none", reply("UNSPECIFIED"), "replied", "replied"],
    ["none", null, "unreplied", "unreplied"],
  ] as const)("操作 %s・返信 %o → %s(%s)", (operation, r, state, bucket) => {
    const s = replyDisplayState(review(operation, r));
    expect(s).toBe(state);
    expect(replyBucket(s)).toBe(bucket);
  });

  it("結果が分からない状態は「反映を確認できていません」、受け付けは「送信結果を確認中」と表示する(送れなかったとは言わない)", () => {
    expect(REPLY_STATE_VIEW.unconfirmed.label).toBe("反映を確認できていません");
    expect(REPLY_STATE_VIEW.checking.label).toBe("送信結果を確認中");
  });
});

describe("絞り込みのクエリ", () => {
  it("既定は未返信。知らない値は既定に戻し、既定値はクエリに書かない", () => {
    expect(DEFAULT_LIST_QUERY.filter).toBe("unreplied");
    expect(parseListQuery(new URLSearchParams("filter=attention&rating=low&sort=lowest"))).toEqual({ filter: "attention", rating: "low", sort: "lowest" });
    expect(parseListQuery(new URLSearchParams("filter=todo"))).toEqual(DEFAULT_LIST_QUERY);
    expect(listQueryString(DEFAULT_LIST_QUERY)).toBe("");
    expect(listQueryString({ ...DEFAULT_LIST_QUERY, filter: "new" })).toBe("filter=new");
  });
});

describe("口コミのキー・一時保存の形", () => {
  it("キーはリソース名の HMAC(鍵が無ければ作らない)。匿名の投稿者の名前・写真は持たない", () => {
    expect(() => reviewKeyFor("accounts/1/locations/2/reviews/3", undefined)).toThrow(ReviewKeyConfigError);
    const key = reviewKeyFor("accounts/1/locations/2/reviews/3", SECRET);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("reviews");
    const cached = toCachedReview(
      {
        name: "accounts/1/locations/2/reviews/3",
        reviewer: { displayName: "匿名", profilePhotoUrl: "https://example.com/p.png", isAnonymous: true },
        starRating: "FOUR",
        comment: "よかった",
        createTime: "2026-10-01T00:00:00Z",
        updateTime: "2026-10-01T00:00:00Z",
        reviewReply: { comment: "ありがとう", reviewReplyState: "SOMETHING_NEW" },
      },
      SECRET,
    );
    expect([cached.reviewKey, cached.reviewerName, cached.reviewerPhotoUrl, cached.starRating, cached.replyState]).toEqual([key, null, null, 4, "UNSPECIFIED"]);
  });

  it("返信の比較は改行・前後の空白をそろえてから", () => {
    expect(normalizeReplyText(" a\r\nb \n")).toBe("a\nb");
    expect(replyHash(" a\r\nb ")).toBe(replyHash("a\nb"));
    expect(replyHash("   ")).toBeNull();
  });
});
