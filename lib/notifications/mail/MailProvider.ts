import type { RawEmail } from "@/lib/notifications/hotpepper/types";

// (hmailの lib/mail/MailProvider.ts を移植・再設計)
// 「あるメールボックスから予約メールの候補を取得する」ことの抽象化。ページ単位で読み、
// 続き(nextPageToken)を呼び出し側が保存して次回そこから再開できるようにする。

export interface MailMessageContent extends RawEmail {
  id: string;
  /** メールボックスに届いた日時(Gmail の internalDate)。不明なら null。 */
  receivedAt: Date | null;
}

export interface MailListPage {
  ids: string[];
  nextPageToken: string | null;
}

export interface MailCallOptions {
  /** この呼び出しのタイムアウト(定期処理の締切に収めるため)。超えたら transient の失敗。 */
  timeoutMs?: number;
}

export interface MailProvider {
  listPage(query: string, pageToken: string | null, pageSize: number, options?: MailCallOptions): Promise<MailListPage>;
  getMessage(id: string, options?: MailCallOptions): Promise<MailMessageContent>;
}

export type MailProviderErrorKind =
  | "invalid_grant"
  | "insufficient_scope"
  | "config"
  | "invalid_page_token"
  | "not_found"
  /** 指定したタイムアウトまでに応答が無かった(締切に合わせて縮めた場合は、失敗ではなく「時間切れ」として扱う)。 */
  | "timeout"
  | "transient";

/**
 * Gmail 等の呼び出しの失敗を分類したもの。
 *   insufficient_scope: その機能(予約メール)の権限だけが足りない。結び付けの側に記録し、
 *     Google アカウント全体の認証の失敗としては数えない(同じアカウントの口コミを巻き込まない)
 *   invalid_grant: 認可そのものが無効(アカウント全体の再認証の扱い)
 *   それ以外: 一時的な障害など(再接続を求めない)
 */
export class MailProviderError extends Error {
  constructor(readonly kind: MailProviderErrorKind) {
    super(`mail_provider:${kind}`);
    this.name = "MailProviderError";
  }
}
