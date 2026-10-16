"use client";

import { useEffect, useState } from "react";
import { normalizeEmail } from "@/lib/onboarding/salonProfile";

type RetryInfo = { retryAfterSeconds?: number; retryScope?: "address" | "connection" };

// 送信の待ち時間(新規登録・確認メールの再送)。サーバーが返した残りの秒数だけを使う(画面で推測しない)。
//   アドレスごと(address): そのアドレスへの送信の間隔。入力し直して同じアドレスに戻っても続く。別のアドレスには当てはまらない
//   接続元ごと(connection): この接続元からの回数の上限。どのアドレスにも当てはまる
// 残りの秒数は時刻の差で出す(タイマーが遅れても、実際の残り時間になる)。
export function useSendWaits() {
  const [byAddress, setByAddress] = useState<Record<string, number>>({});
  const [connectionUntil, setConnectionUntil] = useState(0);
  const [now, setNow] = useState(0);
  const latest = Math.max(connectionUntil, ...Object.values(byAddress));

  useEffect(() => {
    if (latest <= Date.now()) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= latest) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [latest]);

  /** サーバーの応答の待ち時間を記録する(待ち時間が無い応答では何もしない)。 */
  function record(email: string, res: RetryInfo) {
    if (!res.retryAfterSeconds || res.retryAfterSeconds <= 0) return;
    const t = Date.now();
    const until = t + res.retryAfterSeconds * 1000;
    setNow(t);
    if (res.retryScope === "connection") setConnectionUntil((u) => Math.max(u, until));
    else setByAddress((m) => ({ ...m, [normalizeEmail(email)]: until }));
  }

  /** そのアドレスで、あと何秒待つか(0 = 送れる)。 */
  function waitSecondsFor(email: string): number {
    const until = Math.max(byAddress[normalizeEmail(email)] ?? 0, connectionUntil);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  return { record, waitSecondsFor };
}
