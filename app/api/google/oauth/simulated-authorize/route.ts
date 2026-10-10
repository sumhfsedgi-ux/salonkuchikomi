import { NextRequest, NextResponse } from "next/server";
import { isSimulatedGoogleEnabled } from "@/lib/google/config";
import { getDevSimulatedGoogle } from "@/lib/google/simulated";

// 検証用の擬似 Google の同意画面(テスト用DBでの画面確認だけ。本番では 404)。
// 本物の Google には一切つながない。

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const PASSTHROUGH = ["state", "nonce", "code_challenge", "redirect_uri", "scope", "include_granted_scopes", "prompt", "client_id"];

export async function GET(request: NextRequest) {
  if (!isSimulatedGoogleEnabled()) return new NextResponse(null, { status: 404 });
  const params = request.nextUrl.searchParams;
  const sim = getDevSimulatedGoogle(params.get("client_id") ?? "");
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const hidden = PASSTHROUGH.map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? "")}">`).join("");
  const users = sim.users
    .map((u, i) => `<label><input type="radio" name="sub" value="${escapeHtml(u.sub)}" ${i === 0 ? "checked" : ""}> ${escapeHtml(u.email)}</label><br>`)
    .join("");
  const scopeBoxes = scopes
    .filter((s) => s !== "openid" && s !== "email")
    .map((s) => `<label><input type="checkbox" name="grant" value="${escapeHtml(s)}" checked> ${escapeHtml(s)}</label><br>`)
    .join("");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>擬似Google(検証用)</title></head>
<body style="font-family:sans-serif;padding:24px;max-width:560px">
<p style="background:#fff3cd;padding:8px">これは検証用の擬似Googleの画面です。本物のGoogleにはつながっていません。</p>
<p>prompt: ${escapeHtml(params.get("prompt") ?? "(なし)")}</p>
<form method="post">${hidden}
<h3>アカウント</h3>${users}
<h3>許可する権限</h3>${scopeBoxes || "(基本情報のみ)"}
<p><button type="submit" name="decision" value="allow">許可する</button> <button type="submit" name="decision" value="deny">拒否する</button></p>
</form></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(request: NextRequest) {
  if (!isSimulatedGoogleEnabled()) return new NextResponse(null, { status: 404 });
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const redirectUri = new URL(get("redirect_uri"));
  if (redirectUri.origin !== new URL(request.url).origin) return new NextResponse(null, { status: 400 });
  if (get("decision") !== "allow") {
    redirectUri.searchParams.set("error", "access_denied");
    redirectUri.searchParams.set("state", get("state"));
    return NextResponse.redirect(redirectUri, 303);
  }
  const sim = getDevSimulatedGoogle(get("client_id"));
  const code = sim.authorize({
    sub: get("sub"),
    requestedScopes: get("scope").split(" ").filter(Boolean),
    grantScopes: form.getAll("grant").map(String),
    includeGrantedScopes: get("include_granted_scopes") === "true",
    prompt: get("prompt") || null,
    nonce: get("nonce"),
    codeChallenge: get("code_challenge"),
    redirectUri: get("redirect_uri"),
  });
  redirectUri.searchParams.set("code", code);
  redirectUri.searchParams.set("state", get("state"));
  return NextResponse.redirect(redirectUri, 303);
}
