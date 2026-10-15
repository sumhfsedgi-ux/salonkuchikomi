import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SignupSentPanel from "@/components/auth/SignupSentPanel";
import {
  formatWait,
  RESEND_ACCEPTED_TEXT,
  resendAcceptedMessage,
  resendButtonLabel,
  secondsUntilWindowEnd,
  SIGNUP_ACCEPTED_TEXT,
  signupSubmitLabel,
  type SignupNoticeMode,
} from "@/lib/onboarding/signupNotice";

type PanelState = { waitSeconds?: number; pending?: boolean; resendInfo?: string | null; resendError?: string | null; email?: string };

function render(mode: SignupNoticeMode, state: PanelState = {}): { html: string; text: string } {
  const html = renderToStaticMarkup(
    createElement(SignupSentPanel, {
      mode,
      email: state.email ?? "owner@example.test",
      waitSeconds: state.waitSeconds ?? 0,
      pending: state.pending ?? false,
      resendInfo: state.resendInfo ?? null,
      resendError: state.resendError ?? null,
      onResend: () => {},
      onReenter: () => {},
    }),
  );
  return { html, text: html.replace(/<[^>]+>/g, "\n").replace(/\n+/g, "\n") };
}

/** 文字の中で、各句が出てくる位置の順(出てこなければ -1)。 */
function positions(text: string, phrases: string[]): number[] {
  return phrases.map((p) => text.indexOf(p));
}

// 実際のメールの到達を前提にした言葉(検証モードでは出さない)
const DELIVERY_WORDS = /確認メールをご確認ください|お送りしました|お送りします|リンク|迷惑メール|届かない/;

describe("新規登録の送信のあとの案内(通常の環境)", () => {
  it("見出し・案内・入力したメールアドレス・届かない場合と再送・入力し直す・ログイン画面へ、の順に出す", () => {
    const { text } = render("live");
    const order = positions(text, [
      "確認メールをご確認ください",
      SIGNUP_ACCEPTED_TEXT.live.body,
      "入力したメールアドレス",
      "owner@example.test",
      "メールが届かない場合",
      "迷惑メールフォルダをご確認ください。",
      "メールアドレスに誤りがないかご確認ください。",
      "登録済みの方は、",
      "確認メールを再送する",
      "メールアドレスを入力し直す",
      "ログイン画面へ",
    ]);
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("送信の前の説明・「送信先」・検証モードの言葉は出さず、送信済み・到達を断定しない", () => {
    const { text } = render("live");
    expect(text).not.toMatch(/メールアドレスとパスワードを登録してください|送信先|検証モード|お送りしました|届きました/);
  });
  it("登録済みの方には、既存のログインとパスワードの再設定の画面へのリンクを出す。同じ説明は重ねない", () => {
    const { html, text } = render("live");
    expect(html).toMatch(/<a [^>]*href="\/login"[^>]*>ログイン<\/a>または<a [^>]*href="\/forgot-password"[^>]*>パスワードの再設定<\/a>をご利用ください。/);
    expect(text.split("登録済み").length - 1).toBe(1);
    expect(text).not.toMatch(/すでに登録済みの場合はメールは届きません/);
  });
  it("長いメールアドレスは折り返す", () => {
    const { html } = render("live", { email: `${"a".repeat(120)}@example.test` });
    expect(html).toMatch(/<dd class="[^"]*\[overflow-wrap:anywhere\][^"]*">a{120}@example\.test<\/dd>/);
  });
});

describe("新規登録の送信のあとの案内(検証モード)", () => {
  it("「登録リクエストを受け付けました」と、メールを送らないことだけを1か所で出す", () => {
    const { text } = render("simulated");
    expect(text).toContain("登録リクエストを受け付けました");
    expect(text).toContain("現在は検証モードのため、実際のメールは送信していません。");
    expect(text.split("検証モード").length - 1).toBe(1);
    expect(text).toContain("owner@example.test");
  });
  it("確認メール・リンク・迷惑メールなど、メールが届く前提の案内を出さない", () => {
    expect(render("simulated").text).not.toMatch(DELIVERY_WORDS);
    // 再送の受付のあとも同じ
    expect(render("simulated", { resendInfo: RESEND_ACCEPTED_TEXT.simulated, waitSeconds: 60 }).text).not.toMatch(DELIVERY_WORDS);
  });
  it("再送の操作は、メールを送らないことが分かる名前にする", () => {
    const { text } = render("simulated");
    expect(text).toContain("再送処理を確認(メール送信なし)");
    expect(text.indexOf("再送処理を確認")).toBeLessThan(text.indexOf("メールアドレスを入力し直す"));
  });
});

describe("再送のボタン", () => {
  it("操作できる・待機中(残りの秒数)・処理中で、言葉を変える", () => {
    expect(resendButtonLabel("live", { pending: false, waitSeconds: 0 })).toBe("確認メールを再送する");
    expect(resendButtonLabel("live", { pending: false, waitSeconds: 32 })).toBe("再送まであと32秒");
    expect(resendButtonLabel("live", { pending: true, waitSeconds: 0 })).toBe("処理しています…");
    expect(resendButtonLabel("simulated", { pending: false, waitSeconds: 0 })).toBe("再送処理を確認(メール送信なし)");
    expect(resendButtonLabel("simulated", { pending: false, waitSeconds: 5 })).toBe("再送処理の確認まであと5秒");
    expect(resendButtonLabel("simulated", { pending: true, waitSeconds: 0 })).toBe("処理しています…");
  });
  it("待機中と処理中は押せない", () => {
    expect(render("live", { waitSeconds: 32 }).html).toMatch(/<button[^>]*disabled=""[^>]*>再送まであと32秒<\/button>/);
    expect(render("live", { pending: true }).html).toMatch(/<button[^>]*disabled=""[^>]*>処理しています…<\/button>/);
    expect(render("live").html).not.toMatch(/<button[^>]*disabled=""[^>]*>確認メールを再送する<\/button>/);
  });
  it("新規登録のボタン: 待機中は残りの秒数を出す(入力し直して同じアドレスに戻ったときも)", () => {
    expect(signupSubmitLabel({ pending: false, waitSeconds: 0 })).toBe("登録して確認メールを受け取る");
    expect(signupSubmitLabel({ pending: false, waitSeconds: 42 })).toBe("あと42秒で送信できます");
    expect(signupSubmitLabel({ pending: true, waitSeconds: 0 })).toBe("送信しています...");
  });
  it("60秒までは秒で、それより長い待ち(1時間の上限)は分と秒で出す", () => {
    expect(formatWait(59)).toBe("59秒");
    expect(formatWait(60)).toBe("60秒");
    expect(resendButtonLabel("live", { pending: false, waitSeconds: 60 })).toBe("再送まであと60秒");
    expect(formatWait(61)).toBe("1分1秒");
    expect(formatWait(120)).toBe("2分");
    expect(formatWait(2950)).toBe("49分10秒");
  });
  it("受付のあとは、登録済みかどうか・到達を断定しない共通の文。失敗は文字で出す(色だけにしない)", () => {
    expect(RESEND_ACCEPTED_TEXT.live).toBe("再送を受け付けました。お手続きが可能な場合、ご入力のメールアドレスに確認メールをお送りします。");
    expect(RESEND_ACCEPTED_TEXT.live).not.toMatch(/お送りしました|届きました|確認待ち|登録済み/);
    expect(render("live", { resendInfo: RESEND_ACCEPTED_TEXT.live }).html).toContain(`<div role="status" class="text-sm text-ink"><p class="mt-2">${RESEND_ACCEPTED_TEXT.live}</p></div>`);
    const failed = render("live", { resendError: "短い間に操作が続いています。少し時間をおいてから、もう一度お試しください。" }).html;
    expect(failed).toMatch(/<div role="alert"[^>]*>短い間に操作が続いています。/);
  });
  it("ログイン画面の再送(検証モードの説明がほかに無い)では、受付の文に検証モードの説明を付ける", () => {
    expect(resendAcceptedMessage("live")).toBe(RESEND_ACCEPTED_TEXT.live);
    expect(resendAcceptedMessage("simulated")).toBe("再送処理を受け付けました。現在は検証モードのため、実際のメールは送信していません。");
  });
  it("回数の制限にかかったときの残り時間は、0012 の固定の窓が終わるまで", () => {
    const base = Date.UTC(2026, 9, 14, 3, 0, 0);
    expect(secondsUntilWindowEnd(base + 28_000, 60)).toBe(32);
    expect(secondsUntilWindowEnd(base + 28_400, 60)).toBe(32);
    expect(secondsUntilWindowEnd(base, 60)).toBe(60);
    expect(secondsUntilWindowEnd(base + 59_999, 60)).toBe(1);
    expect(secondsUntilWindowEnd(base + 10 * 60_000, 3600)).toBe(3000);
  });
});
