"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nextStepAction } from "@/app/auth/actions";
import { linkProblemOf, LINK_PROBLEM_MESSAGES, nextActionsFor, parseAuthLink, type AuthLink, type LinkType } from "@/lib/onboarding/authLink";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

// メールのリンクの受け口(/auth/confirm)。この画面だけのクライアントで、URL を自動では処理しない
// (共通のクライアントは PKCE で、フラグメントのトークンを受け付けず、code を自動で交換してしまうため)。
//   - token_hash: ボタンを押してから verifyOtp で検証する(メールのリンクの先読みで、トークンが使われないように)
//   - code / フラグメントのトークン: 開いたときに交換・設定する
// 読み取った値は、すぐにアドレス欄から消す(履歴・画面の共有に残さない)。検証のあとは、サーバーが決めた次の場所へ進む。

type State =
  | { kind: "reading" }
  | { kind: "confirm"; link: Extract<AuthLink, { kind: "token_hash" }>; currentEmail: string | null }
  | { kind: "working" }
  | { kind: "problem"; message: string; actions: string[] }
  | { kind: "signed_in_continue" };

function browserClient(): SupabaseClient {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    auth: { detectSessionInUrl: false },
  });
}

const BUTTON_LABELS: Record<LinkType, string> = {
  email: "メールアドレスを確認して続ける",
  signup: "メールアドレスを確認して続ける",
  invite: "招待を受けて続ける",
  magiclink: "ログインして続ける",
  recovery: "手続きを続ける",
};

// ボタンを押す前の説明。確認はまだ済んでいない(リンクの先読みで手続きが進まないよう、押してから確かめる)。
// 押すと何が完了し、どこへ進むかを書く(「確認しました」とは書かない)。
const BEFORE_BUTTON_TEXTS: Record<LinkType, string> = {
  email: "下のボタンを押すと、メールアドレスの確認を完了して、次の手続きに進みます。",
  signup: "下のボタンを押すと、メールアドレスの確認を完了して、次の手続きに進みます。",
  invite: "下のボタンを押すと、招待を受けて、パスワードの設定に進みます。",
  magiclink: "下のボタンを押すと、ログインして、登録内容の確認に進みます。",
  recovery: "下のボタンを押すと、パスワードの手続きに進みます。",
};

export default function AuthLinkHandler() {
  const [state, setState] = useState<State>({ kind: "reading" });
  const [linkType, setLinkType] = useState<LinkType | null>(null);
  const started = useRef(false);

  async function goNext() {
    const next = await nextStepAction();
    window.location.replace(next);
  }

  function fail(code: string | null | undefined, type: LinkType | null) {
    setState({ kind: "problem", message: LINK_PROBLEM_MESSAGES[linkProblemOf(code)], actions: nextActionsFor(type) });
  }

  useEffect(() => {
    // 開発時の Strict Mode では effect が2回動く。1回目でアドレス欄から消すため、2回目は何もしない
    // (2回目が空の URL を読んで「無効」を出したり、code を二重に交換したりしないように)
    if (started.current) return;
    started.current = true;
    const link = parseAuthLink(window.location.search, window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    const client = browserClient();
    (async () => {
      if (link.kind === "error") return fail(link.code, null);
      if (link.kind === "token_hash") {
        setLinkType(link.type);
        const { data } = await client.auth.getSession();
        return setState({ kind: "confirm", link, currentEmail: data.session?.user.email ?? null });
      }
      if (link.kind === "code") {
        setState({ kind: "working" });
        const { error } = await client.auth.exchangeCodeForSession(link.code);
        if (error) return fail(error.code ?? "bad_code_verifier", null);
        return goNext();
      }
      if (link.kind === "session") {
        setState({ kind: "working" });
        const { error } = await client.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
        if (error) return fail(error.code, null);
        return goNext();
      }
      const { data } = await client.auth.getSession();
      if (data.session) return setState({ kind: "signed_in_continue" });
      return fail(null, null);
    })();
  }, []);

  async function verify(link: Extract<AuthLink, { kind: "token_hash" }>) {
    setState({ kind: "working" });
    const client = browserClient();
    const { error } = await client.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type === "signup" ? "email" : link.type });
    if (error) return fail(error.code, link.type);
    await goNext();
  }

  if (state.kind === "reading" || state.kind === "working") {
    return (
      <p className="py-2 text-center text-sm text-ink-muted" role="status">
        {state.kind === "reading" ? "読み込んでいます..." : "手続きをしています..."}
      </p>
    );
  }

  if (state.kind === "confirm") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink">{BEFORE_BUTTON_TEXTS[state.link.type]}</p>
        {state.currentEmail && (
          <Alert variant="warning">
            <span className="[overflow-wrap:anywhere]">{state.currentEmail}</span>
            でログイン中です。続けると、メールのアカウントに切り替わります。
          </Alert>
        )}
        <Button type="button" fullWidth onClick={() => verify(state.link)}>
          {BUTTON_LABELS[state.link.type]}
        </Button>
      </div>
    );
  }

  if (state.kind === "signed_in_continue") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink">ログインしています。手続きを続けてください。</p>
        <Button type="button" fullWidth onClick={goNext}>
          続ける
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="error">{state.message}</Alert>
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
        {state.actions.map((a) => (
          <li key={a}>{a}</li>
        ))}
        {linkType === null && <li>パスワードを忘れた場合は、パスワードの再設定からお手続きください。</li>}
      </ul>
      <div className="flex flex-col gap-2">
        <Link href="/login" className="text-center text-sm text-ink transition hover:text-sage-dark">
          ログイン画面へ
        </Link>
        <Link href="/forgot-password" className="text-center text-sm text-ink-muted transition hover:text-sage-dark">
          パスワードを再設定する
        </Link>
      </div>
    </div>
  );
}
