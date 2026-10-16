import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isSimulatedGoogleEnabled } from "@/lib/google/config";
import { getDevSimulatedGoogle } from "@/lib/google/simulated";
import { GbpApiError, type GbpApiErrorKind } from "@/lib/gbp/apiClient";
import { getDevSimulatedGbp, resetDevSimulatedGbp, type SimulatedOperation } from "@/lib/gbp/simulated";
import { simulatedGbpDevUsers } from "@/lib/gbp/dev/simulatedFixtures";
import { delayNextMockReply } from "@/lib/replyGeneration/mockGenerator";

// 画面確認(テスト用DB + 架空の Google)で、架空の Google の口コミの API に失敗・遅れ・応答の消失などを起こす操作の口。
// 取得の途中・失敗・結果不明・処理の重なり(返信案の作成中・送信中の連携の変更)を、画面から確かめるために使う。
// 本番(NODE_ENV=production)と、架空モードでない開発サーバーでは 404(lib/google/config.ts の isSimulatedGoogleEnabled)。
// プロセスの中の架空の Google・架空の返信案の状態だけを変える。実在の Google・OpenAI・LINE・DB には何もしない。

const OPERATIONS = ["accounts", "locations", "reviews", "review", "reply", "delete_reply"] as const satisfies readonly SimulatedOperation[];
const ERROR_KINDS = [
  "unauthorized",
  "scope_insufficient",
  "service_disabled",
  "permission_denied",
  "forbidden",
  "not_found",
  "failed_precondition",
  "invalid_argument",
  "rate_limited",
  "unavailable",
  "bad_response",
  "network",
  "timeout",
] as const satisfies readonly GbpApiErrorKind[];
const STARS = ["ONE", "TWO", "THREE", "FOUR", "FIVE"] as const;
const locationName = z.string().regex(/^locations\/[A-Za-z0-9-]{1,40}$/);
const reviewName = z.string().regex(/^accounts\/[A-Za-z0-9-]{1,40}\/locations\/[A-Za-z0-9-]{1,40}\/reviews\/[A-Za-z0-9-]{1,60}$/);

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("fail_next"), operation: z.enum(OPERATIONS), kind: z.enum(ERROR_KINDS) }),
  z.object({ action: z.literal("delay_next"), operation: z.enum(OPERATIONS), ms: z.number().int().min(0).max(60_000) }),
  z.object({ action: z.literal("lose_next_response"), operation: z.enum(["reply", "delete_reply"]) }),
  z.object({ action: z.literal("defer_next_write"), operation: z.enum(["reply", "delete_reply"]) }),
  z.object({ action: z.literal("apply_deferred_writes") }),
  z.object({ action: z.literal("clear_pending") }),
  z.object({ action: z.literal("expire_page_tokens") }),
  z.object({ action: z.literal("add_review"), locationName, starRating: z.enum(STARS), comment: z.string().max(4000) }),
  z.object({ action: z.literal("edit_review"), reviewName, comment: z.string().max(4000) }),
  z.object({ action: z.literal("remove_review"), reviewName }),
  z.object({
    action: z.literal("set_reply_state"),
    reviewName,
    state: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    policyViolation: z.string().regex(/^[A-Z_]{1,60}$/).optional(),
  }),
  z.object({ action: z.literal("set_reply_externally"), reviewName, comment: z.string().max(4000).nullable() }),
  z.object({ action: z.literal("set_reply_response_includes_state"), include: z.boolean() }),
  z.object({
    action: z.literal("set_average"),
    locationName,
    averageRating: z.number().min(1).max(5).nullable(),
    totalReviewCount: z.number().int().min(0).max(100_000).nullable(),
  }),
  z.object({ action: z.literal("delay_next_ai"), ms: z.number().int().min(0).max(60_000) }),
  z.object({ action: z.literal("fail_next_token_refresh"), kind: z.enum(["invalid_grant", "network"]) }),
]);

const notFound = () => new NextResponse(null, { status: 404 });
const sim = () => getDevSimulatedGbp(() => simulatedGbpDevUsers());

function accountOf(location: string): string | null {
  for (const user of simulatedGbpDevUsers()) {
    for (const account of user.accounts) if (account.locations.some((l) => l.name === location)) return account.name;
  }
  return null;
}

/** 架空の Google への呼び出しの記録(最後の50件)と、指定した口コミの返信。 */
export async function GET(request: NextRequest) {
  if (!isSimulatedGoogleEnabled()) return notFound();
  const name = request.nextUrl.searchParams.get("reviewName");
  const parsed = name === null ? null : reviewName.safeParse(name);
  if (parsed && !parsed.success) return NextResponse.json({ error: "invalid_review_name" }, { status: 400 });
  return NextResponse.json({ calls: sim().calls.slice(-50), reply: parsed ? sim().replyOf(parsed.data) : undefined });
}

export async function POST(request: NextRequest) {
  if (!isSimulatedGoogleEnabled()) return notFound();
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const input = parsed.data;
  switch (input.action) {
    case "reset":
      resetDevSimulatedGbp();
      break;
    case "fail_next":
      sim().failNext(input.operation, new GbpApiError(input.kind));
      break;
    case "delay_next":
      sim().delayNext(input.operation, input.ms);
      break;
    case "lose_next_response":
      sim().loseNextResponse(input.operation, new GbpApiError("timeout"));
      break;
    case "defer_next_write":
      sim().deferNextWrite(input.operation);
      break;
    case "clear_pending":
      sim().clearPending();
      delayNextMockReply(0);
      break;
    case "apply_deferred_writes":
      return NextResponse.json({ ok: true, applied: sim().applyDeferredWrites() });
    case "expire_page_tokens":
      sim().expirePageTokens();
      break;
    case "add_review": {
      const account = accountOf(input.locationName);
      if (!account) return NextResponse.json({ error: "unknown_location" }, { status: 400 });
      const at = new Date().toISOString();
      const name = `${account}/${input.locationName}/reviews/sim-add-${Date.now().toString(36)}`;
      sim().addReview(input.locationName, { name, reviewer: { displayName: "架空 追加の投稿者" }, starRating: input.starRating, comment: input.comment, createTime: at, updateTime: at });
      return NextResponse.json({ ok: true, reviewName: name });
    }
    case "edit_review":
      sim().editReview(input.reviewName, input.comment);
      break;
    case "remove_review":
      sim().removeReview(input.reviewName);
      break;
    case "set_reply_state":
      sim().setReplyState(input.reviewName, input.state, input.policyViolation);
      break;
    case "set_reply_externally":
      sim().setReplyExternally(input.reviewName, input.comment);
      break;
    case "set_reply_response_includes_state":
      sim().setReplyResponseIncludesState(input.include);
      break;
    case "set_average":
      sim().setAverage(input.locationName, input.averageRating, input.totalReviewCount);
      break;
    case "delay_next_ai":
      delayNextMockReply(input.ms);
      break;
    case "fail_next_token_refresh":
      getDevSimulatedGoogle(process.env.GOOGLE_CLIENT_ID ?? "simulated-client.apps.invalid").failNextRefresh(input.kind);
      break;
  }
  return NextResponse.json({ ok: true });
}
