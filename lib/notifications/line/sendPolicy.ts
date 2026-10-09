// LINE への実際の送信(Messaging API のプッシュ)を、この環境で行ってよいか。
//
//   - 本番(本番ビルド・Vercel の production・検証用の設定なし): 登録済みの通知先へ実際に送る。
//   - 開発(next dev)・テスト用DBの検証(SALONPACK_VERIFY_MODE)・擬似の Google / LINE ログイン・Vercel のプレビュー:
//     実際には送らない(送信の HTTP 処理を呼ばない)。実送信用のトークンが誤って設定されていても同じ。
//   - 実送信の検証: LINE_REAL_SEND_VERIFY=1 を明示的に設定したときだけ、LINE_REAL_SEND_VERIFY_DESTINATIONS に
//     指定した宛先(カンマ区切りの LINE のユーザー ID)にだけ送る。ほかの宛先には、どの環境でも送らない。
//
// 優先順位: テスト用DB(SALONPACK_VERIFY_MODE)・擬似 Google・擬似 LINE ログインの「送らない」は、実送信の検証の
// フラグより先に判定する(これらと LINE_REAL_SEND_VERIFY=1 が同時にあっても送らない)。検証のフラグは、その次に
// 開発・プレビューの「送らない」より先に判定する(検証は、明示的に有効にしたこのモードだけで行う)。
//
// 判定は、送信の入口(lib/notifications/line/LineClient.ts の pushText)と、テスト通知の画面・Server Action の
// 両方で同じこの関数を使う。値は環境変数からだけ読む(画面・クライアントからは受け取らない)。

export type LineSendPolicy =
  | { mode: "live" }
  | { mode: "simulated"; reason: "development" | "testdb" | "simulated_login" | "preview" }
  | { mode: "verify"; destinations: ReadonlySet<string> };

const DESTINATION_PATTERN = /^U[0-9a-f]{32}$/;

function verifyDestinations(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => DESTINATION_PATTERN.test(v))
  );
}

export function resolveLineSendPolicy(env: Record<string, string | undefined> = process.env): LineSendPolicy {
  if (env.SALONPACK_VERIFY_MODE) return { mode: "simulated", reason: "testdb" };
  if (env.GOOGLE_OAUTH_SIMULATED === "1" || env.LINE_LOGIN_SIMULATED === "1") return { mode: "simulated", reason: "simulated_login" };
  if (env.LINE_REAL_SEND_VERIFY === "1") return { mode: "verify", destinations: verifyDestinations(env.LINE_REAL_SEND_VERIFY_DESTINATIONS) };
  if (env.NODE_ENV !== "production") return { mode: "simulated", reason: "development" };
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") return { mode: "simulated", reason: "preview" };
  return { mode: "live" };
}

/** この宛先へ、実際に LINE の送信(HTTP)を行ってよいか。 */
export function isRealLineSendAllowed(policy: LineSendPolicy, destinationId: string): boolean {
  if (policy.mode === "live") return true;
  if (policy.mode === "verify") return policy.destinations.has(destinationId);
  return false;
}
