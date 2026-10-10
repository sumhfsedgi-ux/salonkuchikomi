import { google, gmail_v1 } from "googleapis";
import { classifyGoogleError } from "@/lib/google/errors";
import {
  MailProviderError,
  type MailCallOptions,
  type MailListPage,
  type MailMessageContent,
  type MailProvider,
} from "@/lib/notifications/mail/MailProvider";

const DEFAULT_TIMEOUT_MS = 10_000;

/** 応答が timeoutMs までに無ければ MailProviderError("timeout")(googleapis の timeout でも通信を打ち切る)。 */
async function withTimeout<T>(timeoutMs: number, call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MailProviderError("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// (hmailの lib/mail/GmailProvider.ts を移植・再設計)
// アクセストークンは呼び出し側(lib/google/accessToken.ts)が保存済みの refresh token から取得して渡す。
// ここでは googleapis に refresh token を持たせない(更新の失敗の分類を1か所にまとめるため)。

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractBodyText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  if (payload.parts && payload.parts.length > 0) {
    const plainPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plainPart?.body?.data) return decodeBase64Url(plainPart.body.data);
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) return stripHtml(decodeBase64Url(htmlPart.body.data));
    for (const part of payload.parts) {
      const nested = extractBodyText(part);
      if (nested) return nested;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) return stripHtml(decodeBase64Url(payload.body.data));
  return "";
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function statusOf(error: unknown): number | undefined {
  const response = (error as { response?: { status?: unknown } } | null)?.response;
  return typeof response?.status === "number" ? response.status : undefined;
}

export class GmailProvider implements MailProvider {
  private readonly gmail: gmail_v1.Gmail;

  constructor(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  private toProviderError(error: unknown, context: "list" | "get"): MailProviderError {
    if (error instanceof MailProviderError) return error;
    const status = statusOf(error);
    if (context === "list" && status === 400) return new MailProviderError("invalid_page_token");
    if (context === "get" && status === 404) return new MailProviderError("not_found");
    const kind = classifyGoogleError(error);
    return new MailProviderError(kind);
  }

  async listPage(query: string, pageToken: string | null, pageSize: number, options?: MailCallOptions): Promise<MailListPage> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const { data } = await withTimeout(timeoutMs, () =>
        this.gmail.users.messages.list(
          {
            userId: "me",
            q: query,
            maxResults: pageSize,
            pageToken: pageToken ?? undefined,
          },
          { timeout: timeoutMs }
        )
      );
      return {
        ids: (data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)),
        nextPageToken: data.nextPageToken ?? null,
      };
    } catch (error) {
      throw this.toProviderError(error, "list");
    }
  }

  async getMessage(id: string, options?: MailCallOptions): Promise<MailMessageContent> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const { data } = await withTimeout(timeoutMs, () =>
        this.gmail.users.messages.get({ userId: "me", id, format: "full" }, { timeout: timeoutMs })
      );
      const headers = data.payload?.headers;
      const internal = Number(data.internalDate);
      return {
        id,
        from: getHeader(headers, "From"),
        subject: getHeader(headers, "Subject"),
        bodyText: extractBodyText(data.payload) || data.snippet || "",
        receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal) : null,
      };
    } catch (error) {
      throw this.toProviderError(error, "get");
    }
  }
}
