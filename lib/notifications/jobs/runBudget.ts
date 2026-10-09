// 定期処理の実行時間の管理。Vercel の関数は maxDuration(app/api/cron/notifications/poll-mail/route.ts)を
// 過ぎると途中で強制終了されるため、その手前の締切までに「新しい処理を始めない」ことで、
// 結果の記録まで終えてから戻る。
//   - 締切(新しい処理を始めてよい期限)と、上限(関数が強制終了される前の最後の時刻)の2つを持つ。
//     締切のあとに行ってよいのは、始めていた処理の結果の記録と、送らなかった配信を戻す後片付けだけ
//   - 外部への呼び出し(Gmail・LINE)のタイムアウトは、締切までの残り時間に収まる長さに縮める
//     (ただし下限より短くはしない。下限も収まらないときは、その処理を始めない)
//   - DB への問い合わせも、残り時間に収まる長さで打ち切る(lib/notifications/dbTimeLimit.ts)。
//     問い合わせの応答のあとにも残り時間を確かめ直し、足りなければ LINE を呼ばない
//   - 始めなかった処理は次の回へ回す(失敗として数えない・先にクレームしない)
//   - 店舗ごとに残り時間を分け、1つの店舗が全体の時間を使い切らないようにする

export interface Deadline {
  /** 締切までの残り時間(ミリ秒。過ぎていれば 0)。 */
  remainingMs(): number;
  /** 最長 ms かかる処理を今から始めても、締切までに終わるか。 */
  allows(ms: number): boolean;
  /** 上限(強制終了の前の最後の時刻)までの残り時間。結果の記録・後片付けにだけ使う。 */
  hardRemainingMs(): number;
  /** 残り時間のうち最長 maxMs だけを使う締切(親の締切は越えない。上限は親と同じ)。 */
  child(maxMs: number): Deadline;
}

/** 定期処理1回分に使う時間(締切)。route の maxDuration(60秒)から余裕を引いた値。 */
export const CRON_RUN_BUDGET_MS = 45_000;
/** 上限: maxDuration(60秒)から、応答を返す余裕を引いた値。 */
export const CRON_HARD_LIMIT_MS = 57_000;

export function createDeadline(budgetMs: number, now: () => number = Date.now, hardLimitMs?: number): Deadline {
  const start = now();
  const endsAt = start + Math.max(0, budgetMs);
  const hardEndsAt = start + Math.max(budgetMs, hardLimitMs ?? budgetMs + (CRON_HARD_LIMIT_MS - CRON_RUN_BUDGET_MS));
  return deadlineAt(endsAt, hardEndsAt, now);
}

function deadlineAt(endsAt: number, hardEndsAt: number, now: () => number): Deadline {
  const deadline: Deadline = {
    remainingMs: () => Math.max(0, endsAt - now()),
    allows: (ms) => deadline.remainingMs() >= ms,
    hardRemainingMs: () => Math.max(0, hardEndsAt - now()),
    child: (maxMs) => deadlineAt(Math.min(endsAt, now() + Math.max(0, maxMs)), hardEndsAt, now),
  };
  return deadline;
}

/**
 * 締切までに「呼び出し + そのあとの記録(marginMs)」が収まる、呼び出しのタイムアウト。
 * 通常の長さ(normalMs)を上限に、残り時間に合わせて縮める。下限(minMs)も収まらなければ null(始めない)。
 */
export function callTimeout(deadline: Deadline, normalMs: number, minMs: number, marginMs: number): number | null {
  const available = deadline.remainingMs() - marginMs;
  if (available < minMs) return null;
  return Math.min(normalMs, available);
}

/** Gmail の API 1回分の通常のタイムアウトと、締切が近いときに縮めてよい下限。 */
export const GMAIL_CALL_TIMEOUT_MS = 10_000;
export const GMAIL_MIN_CALL_MS = 2_000;
/** Gmail の呼び出しのあとの記録(続きの保存・分類と配信行の作成)に残す時間。 */
export const GMAIL_RECORD_MARGIN_MS = 2_000;

/** DB への問い合わせ1回の下限(これより短い時間しか残っていなければ、問い合わせを始めない)。 */
export const MIN_DB_CALL_MS = 500;

/** LINE への送信1回分の通常のタイムアウト(lib/notifications/line/LineClient.ts)と下限。 */
export const LINE_SEND_TIMEOUT_MS = 10_000;
export const LINE_MIN_SEND_MS = 3_000;
/** 送信のあとの結果の記録に、締切の内側で残しておく時間。 */
export const SEND_RECORD_MARGIN_MS = 3_000;
/** 送信の前の問い合わせ(取り出し・送信直前の確認)が終わった時点で、少なくとも残っていなければならない時間。 */
export const PRE_SEND_RESERVE_MS = LINE_MIN_SEND_MS + SEND_RECORD_MARGIN_MS;
/** 配信を1件取り出してよい残り時間(取り出しと送信直前の確認に最低限の時間を残したうえで、送信と記録が締切に収まる)。 */
export const SEND_START_MS = PRE_SEND_RESERVE_MS + 2 * MIN_DB_CALL_MS;

/** 保存済みの refresh token からのアクセストークンの取得(lib/google/transport.ts のタイムアウト10秒は固定)。 */
export const TOKEN_BUDGET_MS = 10_000 + 1_000;
/** 1店舗の処理を始めるのに最低限必要な時間(トークンの取得、または Gmail の確認と配信1件)。 */
export const MIN_SALON_SLICE_MS = 12_000;
