"use client";

import { createContext, useContext } from "react";
import type { ReviewListQuery, ReviewSummary } from "@/lib/googleReviews/types";
import { DEFAULT_LIST_QUERY, INBOX_PATH } from "@/lib/googleReviews/query";

// 届いた口コミの一覧と詳細の間で共有する状態。
//   query            : 今の絞り込み・並び順(一覧と詳細の間のリンクに引き継ぐ)
//   twoColumn        : 2列(一覧＋詳細)で表示しているか(届いた口コミの領域の実際の幅で決める)
//   updateItem       : 詳細での操作(既読・下書き・状態の確認)を一覧の行にすぐ反映する
//   cameFromList     : 1列のとき、一覧から開いたか(戻るときに履歴を戻すかどうか)
//   basePath         : 届いた口コミの画面の URL
//   nextUnrepliedHref: 読み込み済みの一覧で、この口コミの次の未返信の口コミ(無ければ null。行き止まりのボタンを出さない)
//   locationId       : 今表示している選択の世代。詳細・返信案の結果が違う世代のものなら表示しない(計画 第2版 §3-A)
export interface InboxContextValue {
  basePath: string;
  query: ReviewListQuery;
  twoColumn: boolean;
  updateItem: (id: string, patch: Partial<ReviewSummary>) => void;
  cameFromList: () => boolean;
  nextUnrepliedHref: (currentId: string) => string | null;
  locationId: string | null;
}

const fallback: InboxContextValue = {
  basePath: INBOX_PATH,
  query: DEFAULT_LIST_QUERY,
  twoColumn: false,
  updateItem: () => {},
  cameFromList: () => false,
  nextUnrepliedHref: () => null,
  locationId: null,
};

export const InboxContext = createContext<InboxContextValue>(fallback);

export function useInbox(): InboxContextValue {
  return useContext(InboxContext);
}
