import type { RawEmail } from "@/lib/notifications/hotpepper/types";

// (hmailの lib/mail/MailProvider.ts を無変更で移植)

export interface MailMessageContent extends RawEmail {
  id: string;
}

/**
 * 「あるメールボックスから予約メールの候補を取得する」ことの抽象化。
 * 今のところGmailProviderのみが実装だが、将来別のプロバイダを追加しても
 * Hot Pepper判定・パースやジョブのオーケストレーション側には手を入れずに済む。
 */
export interface MailProvider {
  /** 予約メールかもしれない候補のメッセージIDを安価に検索する。 */
  listCandidateMessageIds(): Promise<string[]>;
  /** 1通の送信元・件名・本文全体を取得する。 */
  getMessage(id: string): Promise<MailMessageContent>;
  /** このプロバイダインスタンスが接続しているメールボックスのアドレス。 */
  getConnectedEmailAddress(): Promise<string>;
}

/**
 * 保存済みの認証情報が無効になった場合(例: Googleのrefresh tokenが失効・
 * 取り消された)にthrowされる。呼び出し元はこれを使って「接続が壊れている
 * のでオーナーに再接続を促す」ケースと、単なる一時的なネットワークエラーを
 * 区別する。
 */
export class MailConnectionInvalidError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "MailConnectionInvalidError";
  }
}
