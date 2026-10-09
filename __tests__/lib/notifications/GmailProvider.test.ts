import { describe, expect, it, vi, beforeEach } from "vitest";

// GmailProvider(1ページ単位の取得と、エラーの分類)の回帰テスト。外部API(googleapis)は全てモック。
// 続きからの再開・ページ数の上限・読み飛ばしの防止は lib/notifications/mail/gmailScan.ts 側で確かめる。

const listMock = vi.fn();
const getMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
      },
    },
    gmail: () => ({ users: { messages: { list: listMock, get: getMock } } }),
  },
}));

const { GmailProvider } = await import("@/lib/notifications/mail/GmailProvider");
const { MailProviderError } = await import("@/lib/notifications/mail/MailProvider");

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
});

describe("GmailProvider.listPage", () => {
  it("1ページ分のIDと続き(nextPageToken)を返し、渡した page token を使う", async () => {
    listMock.mockResolvedValueOnce({ data: { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "t2" } });
    const provider = new GmailProvider("access-token");
    const page = await provider.listPage("q", "t1", 50);
    expect(page).toEqual({ ids: ["a", "b"], nextPageToken: "t2" });
    expect(listMock.mock.calls[0][0]).toMatchObject({ q: "q", pageToken: "t1", maxResults: 50 });
  });

  it("最後のページは nextPageToken が null", async () => {
    listMock.mockResolvedValueOnce({ data: { messages: [] } });
    const page = await new GmailProvider("access-token").listPage("q", null, 50);
    expect(page).toEqual({ ids: [], nextPageToken: null });
  });

  it("400(page token が無効)は invalid_page_token、invalid_grant は認証の失敗、5xx は一時的な障害", async () => {
    const provider = new GmailProvider("access-token");
    listMock.mockRejectedValueOnce({ response: { status: 400 } });
    await expect(provider.listPage("q", "bad", 50)).rejects.toMatchObject({ kind: "invalid_page_token" });
    listMock.mockRejectedValueOnce({ response: { status: 400, data: { error: "invalid_grant" } } });
    await expect(provider.listPage("q", null, 50)).rejects.toBeInstanceOf(MailProviderError);
    listMock.mockRejectedValueOnce({ response: { status: 503 } });
    await expect(provider.listPage("q", null, 50)).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("タイムアウト(定期処理の締切に合わせて縮めた長さ)", () => {
  it("指定した時間までに応答が無ければ timeout。googleapis にも同じ長さを渡して通信を打ち切る", async () => {
    listMock.mockImplementationOnce(() => new Promise(() => {}));
    await expect(new GmailProvider("access-token").listPage("q", null, 50, { timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
    expect(listMock.mock.calls[0][1]).toEqual({ timeout: 20 });
    getMock.mockImplementationOnce(() => new Promise(() => {}));
    await expect(new GmailProvider("access-token").getMessage("m", { timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("GmailProvider.getMessage", () => {
  it("受信日時(internalDate)を返す", async () => {
    getMock.mockResolvedValueOnce({
      data: {
        internalDate: "1791400000000",
        payload: { headers: [{ name: "From", value: "f" }, { name: "Subject", value: "s" }], mimeType: "text/plain", body: { data: Buffer.from("本文").toString("base64url") } },
      },
    });
    const message = await new GmailProvider("access-token").getMessage("m1");
    expect(message.receivedAt?.getTime()).toBe(1791400000000);
    expect(message.bodyText).toBe("本文");
  });

  it("削除済み(404)は not_found(分類の再試行の上限で unprocessable になる)", async () => {
    getMock.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(new GmailProvider("access-token").getMessage("gone")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("権限不足(403 insufficientPermissions)は insufficient_scope", async () => {
    getMock.mockRejectedValueOnce({ response: { status: 403, data: { error: { errors: [{ reason: "insufficientPermissions" }] } } } });
    await expect(new GmailProvider("access-token").getMessage("m")).rejects.toMatchObject({ kind: "insufficient_scope" });
  });
});
