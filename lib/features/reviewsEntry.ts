// 「口コミ」の入口(口コミプランのログイン後・左メニューの「口コミ」・SalonPack のホームの「口コミ」)。
//   ・Google口コミ(google_reviews。口コミの確認・返信)を使える店舗は「口コミ」タブを開く。アンケートが未作成でも、
//     アンケートの初期設定へは移さない(Google と未連携なら、「口コミ」タブの中で連携を案内する)
//   ・使えない店舗は、今まで通りアンケート(未作成なら初期設定)
// タブの名前だけを変えたため、URL・機能の ID は変えない(「口コミ」タブ = /dashboard/reviews/google、
// 「アンケート」タブ = /dashboard/reviews、「設定」タブ = /dashboard/reviews/settings)。
// 画面(PC・スマートフォンのメニュー)からも読むので、ここには定数と純粋な関数だけを置く。使えるかの判定は
// lib/features/access.ts の isReviewsTabUsable。

export const REVIEWS_TAB_PATH = "/dashboard/reviews/google";
export const SURVEY_TAB_PATH = "/dashboard/reviews";
export const REVIEWS_SETTINGS_TAB_PATH = "/dashboard/reviews/settings";
/** 「口コミ」の画面の全体(どのタブでも、メニューの「口コミ」を選択中にする)。 */
export const REVIEWS_SECTION_PATH = "/dashboard/reviews";

export function reviewsEntryPath(reviewsTabUsable: boolean): string {
  return reviewsTabUsable ? REVIEWS_TAB_PATH : SURVEY_TAB_PATH;
}
