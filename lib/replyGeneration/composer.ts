// 返信欄の扱いの決まり(画面の状態から切り離した純粋な関数)。
//   ・返信欄を手直ししているとき(直前の AI の案と違うとき)は、再生成した案で上書きしない。
//     新しい案は「別の案」として出し、置き換えるかどうかを本人に選んでもらう。
//   ・返信欄が空、または直前の AI の案のまま(手直しなし)なら、新しい案に置き換えてよい。
// 生成を待つ間の入力も守る置き方は lib/replyGeneration/suggestion.ts。

/** 返信欄が直前の AI の案から手直しされているか。前後の空白の違いだけなら手直しとみなさない。 */
export function isReplyEdited(current: string, lastAiReply: string | null): boolean {
  const trimmed = current.trim();
  if (!trimmed) return false;
  if (lastAiReply === null) return true;
  return trimmed !== lastAiReply.trim();
}

export type NewDraftPlacement = "replace" | "alternative";

/** 新しく届いた AI の案を、返信欄に入れるか「別の案」として出すか。 */
export function placeNewDraft(current: string, lastAiReply: string | null): NewDraftPlacement {
  return isReplyEdited(current, lastAiReply) ? "alternative" : "replace";
}
