import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// AI返信の案の作成のレート制限(0012 の rate_limit_hit を使う)。オーナーがログインして使う機能なので、
// IP ではなく店舗ごとに数える。上限は環境変数で変えられる。
//   店舗: 10分に30回 / 1日に100回
// 上限を確かめられないとき(DB のエラー・0012 の適用前・想定外の応答)は、作成を一時停止する
// (scope: "unavailable")。お客様が使う口コミ生成(lib/reviewGeneration/rateLimit.ts)は、お客様の
// 生成を止めないよう DB のエラーで通す方針のままで、ここの判断はその動きを変えない。

const SHORT_WINDOW_SECONDS = 10 * 60;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DEFAULT_PER_10MIN = 30;
const DEFAULT_PER_DAY = 100;

function readLimit(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type ReplyRateLimitDecision =
  | { allowed: true }
  | { allowed: false; scope: "short" | "daily" }
  /** 上限を確かめられなかった。作らずに一時停止する。 */
  | { allowed: false; scope: "unavailable" };

type HitResult = "allowed" | "limited" | "unavailable";

async function hit(admin: SupabaseClient, key: string, windowSeconds: number, limit: number): Promise<HitResult> {
  try {
    const { data, error } = await admin.rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    if (error) {
      console.warn("reply rate limit unavailable; pausing generation", { code: error.code });
      return "unavailable";
    }
    if (data === true) return "allowed";
    if (data === false) return "limited";
    console.warn("reply rate limit returned an unexpected value; pausing generation");
    return "unavailable";
  } catch {
    console.warn("reply rate limit unavailable; pausing generation");
    return "unavailable";
  }
}

export async function checkReplyRateLimit(admin: SupabaseClient, salonId: string): Promise<ReplyRateLimitDecision> {
  const per10Min = readLimit("REPLY_RATE_LIMIT_SALON_PER_10MIN", DEFAULT_PER_10MIN);
  const perDay = readLimit("REPLY_RATE_LIMIT_SALON_PER_DAY", DEFAULT_PER_DAY);
  const short = await hit(admin, `rp:salon10m:${salonId}`, SHORT_WINDOW_SECONDS, per10Min);
  if (short !== "allowed") return { allowed: false, scope: short === "limited" ? "short" : "unavailable" };
  const daily = await hit(admin, `rp:salonday:${salonId}`, DAILY_WINDOW_SECONDS, perDay);
  if (daily !== "allowed") return { allowed: false, scope: daily === "limited" ? "daily" : "unavailable" };
  return { allowed: true };
}
