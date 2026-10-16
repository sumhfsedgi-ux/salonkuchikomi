// AI の返信案を、返信欄に入れるか「別の案」として出すか(docs/plans/google-reviews-inbox-plan.md §8-5)。
// 結果が届いた時点の返信欄の文章で決める(作り始めた時点の文章ではない)。手直しした文章・生成を待つ間に入力した
// 文章は上書きしない。

export interface SuggestionContext {
  /** 結果が届いた時点の返信欄の文章。 */
  current: string;
  /** 案を頼んだ時点の返信欄の文章。 */
  atRequest: string;
  /** 直前に返信欄へ入れた AI の案(無ければ null)。 */
  lastAi: string | null;
}

export function suggestionPlacement({ current, atRequest, lastAi }: SuggestionContext): "replace" | "alternative" {
  // 返信欄が空なら、守る文章が無い。
  if (!current.trim()) return "replace";
  // 生成を待つ間に入力・修正した。
  if (current !== atRequest) return "alternative";
  // 直前の AI の案のまま(手直ししていない)なら入れ替える。それ以外(手で書いた・手直しした)は残す。
  return lastAi !== null && current.trim() === lastAi.trim() ? "replace" : "alternative";
}
