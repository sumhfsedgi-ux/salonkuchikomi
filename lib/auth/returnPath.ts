// ログインのあとに戻る先(LINE の口コミ通知の［口コミを確認する］から開いた口コミ詳細へ戻すため)。
// 許可するのは口コミ詳細(/dashboard/reviews/google/<SalonPack 内の UUID>)の形だけ。外部の URL・ほかのパス・クエリ付き・
// 形の違う値は使わず、従来どおりの行き先(/dashboard や本人確認・店舗の登録)へ進む。
// 戻った先でも、口コミ詳細の画面がその店舗の口コミかを確かめる(他店舗の口コミは「表示できません」)。
//   - ログイン画面へ移すとき(proxy): URL の next と、短い時間の cookie の両方に入れる
//   - ログイン画面: next(無ければ cookie)を LoginForm へ渡し、ログインのあとそこへ移る
//   - 本人確認・メールのリンクのあと(nextStepAction・verifyIdentityAction・/auth/verify): 行き先が /dashboard のときだけ
//     cookie の戻り先を使い、使ったら消す(本人確認・店舗の登録・利用開始待ちの手順は先に通す)

export const RETURN_COOKIE = "sp_return_to";
export const RETURN_COOKIE_MAX_AGE_SECONDS = 30 * 60;

const RETURN_PATH = /^\/dashboard\/reviews\/google\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 戻り先として使える値なら、その値。使えなければ null。 */
export function safeReturnPath(value: unknown): string | null {
  return typeof value === "string" && RETURN_PATH.test(value) ? value : null;
}

/** 次の行き先が /dashboard のときだけ、戻り先に置き換える(ほかの手順はそのまま)。 */
export function withReturnPath<T extends string>(next: T, returnPath: string | null): T | string {
  return next === "/dashboard" && returnPath ? returnPath : next;
}

/** ログイン画面の URL(戻り先があれば next を付ける)。 */
export function loginPathFor(returnPath: string | null): string {
  return returnPath ? `/login?next=${encodeURIComponent(returnPath)}` : "/login";
}
