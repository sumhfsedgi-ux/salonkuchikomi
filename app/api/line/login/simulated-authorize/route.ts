import { NextRequest, NextResponse } from "next/server";
import { isSimulatedLineLoginEnabled, SIMULATED_LINE_CHANNEL_ID } from "@/lib/notifications/line/login/config";
import { getDevSimulatedLineLogin } from "@/lib/notifications/line/login/simulated";

// 検証用の擬似 LINE ログインの画面(テスト用DBでの画面確認だけ。本番では 404)。本物の LINE には一切つながない。

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const PASSTHROUGH = ["state", "nonce", "code_challenge", "redirect_uri", "client_id", "bot_prompt"];

export async function GET(request: NextRequest) {
  if (!isSimulatedLineLoginEnabled()) return new NextResponse(null, { status: 404 });
  const params = request.nextUrl.searchParams;
  const sim = getDevSimulatedLineLogin(SIMULATED_LINE_CHANNEL_ID);
  const hidden = PASSTHROUGH.map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? "")}">`).join("");
  const users = sim.users
    .map((u, i) => `<label><input type="radio" name="user_id" value="${escapeHtml(u.userId)}" ${i === 0 ? "checked" : ""}> ${escapeHtml(u.name)}</label><br>`)
    .join("");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>擬似LINEログイン(検証用)</title></head>
<body style="font-family:sans-serif;padding:24px;max-width:560px">
<p style="background:#fff3cd;padding:8px">これは検証用の擬似LINEログインの画面です。本物のLINEにはつながっていません。</p>
<p>bot_prompt: ${escapeHtml(params.get("bot_prompt") ?? "(なし)")}</p>
<form method="post">${hidden}
<h3>LINEアカウント</h3>${users}
<p><label><input type="checkbox" name="add_friend" value="1" checked> 公式アカウントを友だち追加する</label></p>
<p><button type="submit" name="decision" value="allow">許可する</button> <button type="submit" name="decision" value="cancel">キャンセル</button></p>
</form></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(request: NextRequest) {
  if (!isSimulatedLineLoginEnabled()) return new NextResponse(null, { status: 404 });
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const redirectUri = new URL(get("redirect_uri"));
  if (redirectUri.origin !== new URL(request.url).origin) return new NextResponse(null, { status: 400 });
  if (get("decision") !== "allow") {
    redirectUri.searchParams.set("error", "access_denied");
    redirectUri.searchParams.set("error_description", "The user has denied the request");
    redirectUri.searchParams.set("state", get("state"));
    return NextResponse.redirect(redirectUri, 303);
  }
  const sim = getDevSimulatedLineLogin(SIMULATED_LINE_CHANNEL_ID);
  const code = sim.authorize({
    userId: get("user_id"),
    addFriend: get("add_friend") === "1",
    nonce: get("nonce"),
    codeChallenge: get("code_challenge"),
    redirectUri: get("redirect_uri"),
  });
  redirectUri.searchParams.set("code", code);
  redirectUri.searchParams.set("state", get("state"));
  if (get("bot_prompt")) redirectUri.searchParams.set("friendship_status_changed", get("add_friend") === "1" ? "true" : "false");
  return NextResponse.redirect(redirectUri, 303);
}
