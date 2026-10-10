import { NextRequest, NextResponse } from "next/server";
import { getLineLoginDeps } from "@/lib/notifications/line/login/runtime";
import { BINDING_COOKIE, bindingHashOf, flowView, parseFlowId, startLineLogin } from "@/lib/notifications/line/login/flow";
import { continuePath } from "@/lib/notifications/line/login/messages";
import { logSafeError } from "@/lib/google/safeError";

// 「LINEで連携する」(招待ページ・結果ページの再試行の両方)。フォームの進行の id(画面に表示した招待)で始める。
// id は、このブラウザ(cookie)の進行で、期限内・招待が有効なときだけ使う(DB で照合する。別のブラウザ・改ざんした id は
// 使えない)。ブラウザ全体の「最新の招待」には切り替えない。招待の値・戻り先はクライアントから受け取らない。

function redirectTo(request: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, request.url), 303);
}

async function formFlowId(request: NextRequest): Promise<string | null> {
  try {
    return parseFlowId((await request.formData()).get("flow"));
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const deps = getLineLoginDeps();
  if (!deps) return redirectTo(request, continuePath(null));
  const flowId = await formFlowId(request);
  const bindingHash = bindingHashOf(request.cookies.get(BINDING_COOKIE)?.value);
  if (!flowId || !bindingHash) return redirectTo(request, continuePath(null, "browser"));
  try {
    const flow = await flowView(flowId, bindingHash);
    if (!flow) return redirectTo(request, continuePath(null, "browser"));
    // 招待が無効・登録済みなら始めない(結果ページが、その招待の状態を表示する)。
    if (flow.inviteStatus !== "valid" || flow.lastOutcome === "registered") return redirectTo(request, continuePath(flow.flowId));
    const url = await startLineLogin(flow.flowId, bindingHash, deps.config);
    if (!url) return redirectTo(request, continuePath(flow.flowId));
    return NextResponse.redirect(url, 303);
  } catch (error) {
    logSafeError("line/login start", error);
    return redirectTo(request, continuePath(flowId, "start_failed"));
  }
}
