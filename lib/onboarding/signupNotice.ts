// 新規登録の送信のあとの案内の言葉(画面と Server Action で使う)。
// 登録済みかどうか・実際に送ったかどうかで変えない。「お送りしました」「届きました」と断定しない。
// 検証モード(メールを送らない環境)では、メールが届く前提の案内(確認メール・リンク・迷惑メール)を出さない。

/** live は実際に送る環境(AUTH_EMAIL_VERIFY の、許可したアドレスにだけ送る場合を含む)。 */
export type SignupNoticeMode = "live" | "simulated";

export const SIGNUP_ACCEPTED_TEXT: Record<SignupNoticeMode, { title: string; body: string }> = {
  live: {
    title: "確認メールをご確認ください",
    body: "新規登録のお手続きが可能な場合、ご入力のメールアドレスに確認メールをお送りします。メール内のリンクから登録を続けてください。",
  },
  simulated: {
    title: "登録リクエストを受け付けました",
    body: "現在は検証モードのため、実際のメールは送信していません。",
  },
};

/** 再送を受け付けたあと。検証モードの説明は見出しの下の1か所にあるため、ここでは繰り返さない。 */
export const RESEND_ACCEPTED_TEXT: Record<SignupNoticeMode, string> = {
  live: "再送を受け付けました。お手続きが可能な場合、ご入力のメールアドレスに確認メールをお送りします。",
  simulated: "再送処理を受け付けました。",
};

/** ログイン画面の再送(検証モードの説明がほかに無い画面)に出す文。 */
export function resendAcceptedMessage(mode: SignupNoticeMode): string {
  return mode === "simulated" ? `${RESEND_ACCEPTED_TEXT.simulated}${SIGNUP_ACCEPTED_TEXT.simulated.body}` : RESEND_ACCEPTED_TEXT.live;
}

/** 本人確認のメール(パスワード再設定と同じ形式で届く)の送信を受け付けたとき。届いたとは書かない。 */
export const VERIFY_LINK_ACCEPTED_TEXT =
  "受け付けました。登録のメールアドレスに、パスワード再設定と同じ形式のメールをお送りします。メールのリンクを開いて、パスワードを入力または設定してください。";
export const VERIFY_LINK_SIMULATED_TEXT = "現在は検証モードのため、実際のメールは送信していません。";

/** 60秒までは秒で出す(再送の間隔)。それより長い待ち(1時間の上限)は分と秒で出す。 */
export function formatWait(seconds: number): string {
  if (seconds <= 60) return `${seconds}秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

export function resendButtonLabel(mode: SignupNoticeMode, state: { pending: boolean; waitSeconds: number }): string {
  if (state.pending) return "処理しています…";
  if (state.waitSeconds > 0) return mode === "live" ? `再送まであと${formatWait(state.waitSeconds)}` : `再送処理の確認まであと${formatWait(state.waitSeconds)}`;
  return mode === "live" ? "確認メールを再送する" : "再送処理を確認(メール送信なし)";
}

/** 新規登録のボタン(待機中は押せない)。 */
export function signupSubmitLabel(state: { pending: boolean; waitSeconds: number }): string {
  if (state.pending) return "送信しています...";
  if (state.waitSeconds > 0) return `あと${formatWait(state.waitSeconds)}で送信できます`;
  return "登録して確認メールを受け取る";
}

/** 0012 の rate_limit_hit(エポックに揃えた固定の窓)で、今の窓が終わるまでの秒数。 */
export function secondsUntilWindowEnd(nowMs: number, windowSeconds: number): number {
  return Math.max(1, Math.ceil(windowSeconds - ((nowMs / 1000) % windowSeconds)));
}
