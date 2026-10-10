// スタッフ向けの招待ページ・結果ページで共通の文言と、結果ページのパス(サーバー・クライアントの両方から使う)。

export const INVALID_INVITE_MESSAGES: Record<string, string> = {
  expired: "この招待の有効期限(24時間)が切れています。お店の方に新しい招待を依頼してください。",
  used: "この招待はすでに使われています。登録がまだの場合は、お店の方に新しい招待を依頼してください。",
  revoked: "この招待は取り消されています。お店の方に新しい招待を依頼してください。",
  not_found: "招待のリンクが正しくありません。お店の方から届いたリンクを、もう一度開いてください。",
  unavailable: "現在、LINEの通知先の登録はご利用いただけません。お店の方にお問い合わせください。",
  error: "招待を確認できませんでした。時間をおいて、もう一度開いてください。",
};

export const CONTINUE_PATH = "/line/invite/continue";

/** 結果ページで添える案内。結果そのもの(登録できたか)は URL に載せず、サーバーの記録から表示する。 */
export type ContinueNotice = "browser" | "expired" | "start_failed";

/** 結果ページのパス。表示する進行の id(結果ページでも cookie と照合する)と、案内の種類だけを付ける。 */
export function continuePath(flowId: string | null, notice?: ContinueNotice): string {
  const params = new URLSearchParams();
  if (flowId) params.set("f", flowId);
  if (notice) params.set("notice", notice);
  const query = params.toString();
  return query ? `${CONTINUE_PATH}?${query}` : CONTINUE_PATH;
}
