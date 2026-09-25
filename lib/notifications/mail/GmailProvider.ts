import { google, gmail_v1 } from "googleapis";
import { buildCandidateSearchQuery } from "@/lib/notifications/mail/gmailSearchQuery";
import { createAuthorizedClient, classifyGoogleError } from "@/lib/notifications/mail/google-oauth";
import {
  MailConnectionInvalidError,
  type MailMessageContent,
  type MailProvider,
} from "@/lib/notifications/mail/MailProvider";

// (hmailの lib/mail/GmailProvider.ts を無変更で移植)

const MAX_CANDIDATES_PER_RUN = 25;

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

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

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

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }

  return "";
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export class GmailProvider implements MailProvider {
  private readonly gmail: gmail_v1.Gmail;
  private readonly connectedSince: Date;

  constructor(refreshToken: string, connectedSince: Date) {
    const auth = createAuthorizedClient(refreshToken);
    this.gmail = google.gmail({ version: "v1", auth });
    this.connectedSince = connectedSince;
  }

  private wrapError(error: unknown): never {
    if (classifyGoogleError(error) === "invalid_grant") {
      throw new MailConnectionInvalidError("Gmail refresh token is no longer valid", error);
    }
    throw error;
  }

  async getConnectedEmailAddress(): Promise<string> {
    try {
      const { data } = await this.gmail.users.getProfile({ userId: "me" });
      if (!data.emailAddress) throw new Error("Gmail profile has no email address");
      return data.emailAddress;
    } catch (error) {
      this.wrapError(error);
    }
  }

  async listCandidateMessageIds(): Promise<string[]> {
    try {
      const { data } = await this.gmail.users.messages.list({
        userId: "me",
        q: buildCandidateSearchQuery(this.connectedSince),
        maxResults: MAX_CANDIDATES_PER_RUN,
      });
      return (data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    } catch (error) {
      this.wrapError(error);
    }
  }

  async getMessage(id: string): Promise<MailMessageContent> {
    try {
      const { data } = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
      const headers = data.payload?.headers;
      return {
        id,
        from: getHeader(headers, "From"),
        subject: getHeader(headers, "Subject"),
        bodyText: extractBodyText(data.payload) || data.snippet || "",
      };
    } catch (error) {
      this.wrapError(error);
    }
  }
}
