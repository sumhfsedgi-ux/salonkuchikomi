import { after, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callOpenAIJson } from "@/lib/ai/openai";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  eventFieldsFromMetadata,
  recordGenerationEvent,
  V1_PROMPT_VERSION,
  type GenerationEvent,
} from "@/lib/reviewGeneration/events";
import { generateReviewV1 } from "@/lib/reviewGeneration/legacyV1";
import { buildMaterials } from "@/lib/reviewGeneration/materials";
import {
  lintPlainDraft,
  ReviewGenerationError,
  runReviewPipeline,
  runShadowVerification,
} from "@/lib/reviewGeneration/pipeline";
import { checkGenerationRateLimit, clientIp } from "@/lib/reviewGeneration/rateLimit";
import { createRequestTimer, serverTimingHeader, type RequestTimer } from "@/lib/reviewGeneration/timing";
import {
  loadActiveSurvey,
  parseGenerateRequest,
  validateAnswers,
} from "@/lib/reviewGeneration/validateAnswers";

export const runtime = "nodejs";
// v2 は作文・意味検証・修正で最大40秒(lib/reviewGeneration/pipeline.ts)、v1 は30秒×最大2回。
export const maxDuration = 60;

const GENERIC_ERROR = "口コミの作成に失敗しました。もう一度お試しください。";
const STALE_ERROR =
  "アンケートの内容が更新されました。お手数ですが、ページを再読み込みしてからもう一度お試しください。";
const BAD_REQUEST_ERROR = "リクエストの形式が正しくありません。";
const CONFIG_ERROR = "サーバー設定エラーが発生しました。しばらくしてから再度お試しください。";
const RATE_LIMITED_ERROR = "短い時間に続けて作成されたため、少し時間をおいてからもう一度お試しください。";

// 影の意味検証(計測用)をかける割合。同期検証をしなかった v2 の下書きだけが対象。
const DEFAULT_SHADOW_VERIFY_RATE = 0.2;

// REVIEW_PIPELINE=v2 のときだけ v2 を使う(未設定・それ以外は v1)。v1 に戻すときは
// この環境変数を外して再デプロイする(docs/plans/reviews-465-plan.md §13-5)。
function pipelineVersion(): "v1" | "v2" {
  return process.env.REVIEW_PIPELINE?.trim() === "v2" ? "v2" : "v1";
}

function shadowVerifyRate(): number {
  const value = Number.parseFloat(process.env.REVIEW_SHADOW_VERIFY_RATE ?? "");
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_SHADOW_VERIFY_RATE;
}

// レート制限とイベント記録は service role が必要。使えなければ両方とも諦めて、生成は続ける。
function adminClientOrNull(): SupabaseClient | null {
  try {
    return getSupabaseAdmin();
  } catch {
    console.warn("generate-review: service role client unavailable; skipping rate limit and events");
    return null;
  }
}

// 区間ごとの待ち時間を1行だけログに出す(ms と回数・状態だけ。回答・文章・IP は出さない)。
// REVIEW_SERVER_TIMING=1 のときだけ、同じ内容を Server-Timing ヘッダーでも返す(手元の計測用)。
function finish(
  timer: RequestTimer,
  response: NextResponse,
  context: { outcome: string; salonId?: string; pipeline?: "v1" | "v2" },
): NextResponse {
  const summary = timer.summary();
  console.info("generate-review timing", { ...context, status: response.status, ...summary });
  if (process.env.REVIEW_SERVER_TIMING?.trim() === "1") {
    response.headers.set("Server-Timing", serverTimingHeader(summary));
  }
  return response;
}

// 回答・生成した文章はログに出さない(salonId と種類・状態だけを出す)。
export async function POST(request: Request) {
  const timer = createRequestTimer();

  let body: unknown;
  try {
    body = await timer.measure("parse", () => request.json());
  } catch {
    return finish(timer, NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 }), { outcome: "bad_json" });
  }

  const parsed = parseGenerateRequest(body);
  if (!parsed) {
    console.error("Invalid generate-review payload");
    return finish(timer, NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 }), { outcome: "bad_request" });
  }
  const { salonId } = parsed;
  const pipeline = pipelineVersion();

  let survey;
  try {
    survey = await timer.measure("survey", async () => loadActiveSurvey(await createClient(), salonId));
  } catch {
    console.error("generate-review: failed to load survey", { salonId });
    return finish(timer, NextResponse.json({ error: GENERIC_ERROR }, { status: 503 }), { outcome: "survey_error", salonId });
  }
  if (!survey) {
    return finish(timer, NextResponse.json({ error: "店舗またはアンケートが見つかりません。" }, { status: 404 }), {
      outcome: "not_found",
      salonId,
    });
  }

  const loadedSurvey = survey;
  const validation = await timer.measure("validate", () => validateAnswers(loadedSurvey, parsed.answers));
  if (!validation.ok) {
    if (validation.reason === "stale") {
      return finish(timer, NextResponse.json({ error: STALE_ERROR }, { status: 409 }), { outcome: "stale", salonId });
    }
    console.error("generate-review: invalid answers", { salonId, reason: validation.reason });
    return finish(timer, NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 }), { outcome: "invalid", salonId });
  }

  const admin = adminClientOrNull();
  if (admin) {
    const decision = await timer.measure("rateLimit", () => checkGenerationRateLimit(admin, { salonId, ip: clientIp(request) }));
    if (!decision.allowed) {
      console.warn("generate-review: rate limited", { salonId, scope: decision.scope });
      return finish(timer, NextResponse.json({ error: RATE_LIMITED_ERROR }, { status: 429 }), {
        outcome: "rate_limited",
        salonId,
      });
    }
  }

  const generationId = crypto.randomUUID();
  const kind = parsed.previousPlan || parsed.previousReview ? "regenerated" : "generated";
  // 記録は応答を返したあとに行う(お客様の待ち時間に含めない)。
  const record = (event: Omit<GenerationEvent, "generationId" | "salonId">) => {
    if (admin) after(() => recordGenerationEvent(admin, { generationId, salonId, ...event }));
  };
  const materials = buildMaterials(validation.inputs);

  if (pipeline === "v2") {
    try {
      const result = await timer.measure("generation", () =>
        runReviewPipeline(
          {
            materials,
            businessType: loadedSurvey.businessType,
            storeDescription: loadedSurvey.description,
            previousSeed: parsed.previousPlan,
          },
          // 今までと同じ callOpenAIJson を、時間を測るためだけに包む(引数と結果は変えない)。
          { callJson: timer.wrapCallJson(callOpenAIJson) },
        ),
      );
      record({ kind, ...eventFieldsFromMetadata(result.metadata) });

      if (admin && result.metadata.verifyMode === "none" && Math.random() < shadowVerifyRate()) {
        after(async () => {
          const shadow = await runShadowVerification(materials, result.sentences);
          if (!shadow) return;
          await recordGenerationEvent(admin, {
            generationId,
            salonId,
            kind: "shadow_verified",
            pipeline: "v2",
            promptVersion: result.metadata.promptVersion,
            verificationModel: shadow.model,
            latencyMs: shadow.latencyMs,
            inputTokens: shadow.usage?.inputTokens ?? null,
            outputTokens: shadow.usage?.outputTokens ?? null,
            llmCalls: 1,
            verifyMode: "shadow",
            verifyFlags: shadow.unsupportedCount > 0 ? [...shadow.verifyFlags, "has_unsupported"] : shadow.verifyFlags,
          });
        });
      }

      // 再生成のときに前回と違う書き方にするため、Style Seed を返す(本文は含まない)。
      return finish(timer, NextResponse.json({ review: result.draft, generationId, plan: result.seed }), {
        outcome: kind,
        salonId,
        pipeline,
      });
    } catch (err) {
      if (!(err instanceof ReviewGenerationError)) {
        console.error("generate-review v2: unexpected error", { salonId });
        record({ kind: "failed", pipeline: "v2", errorKind: "unexpected" });
        return finish(timer, NextResponse.json({ error: GENERIC_ERROR }, { status: 502 }), {
          outcome: "failed:unexpected",
          salonId,
          pipeline,
        });
      }
      console.error("generate-review v2 failed", { salonId, kind: err.kind, cause: err.causeKind });
      record({
        ...(err.metadata ? eventFieldsFromMetadata(err.metadata) : { pipeline: "v2" }),
        kind: "failed",
        errorKind: err.causeKind ? `${err.kind}:${err.causeKind}` : err.kind,
      });
      const failure = { outcome: `failed:${err.kind}`, salonId, pipeline };
      if (err.kind === "config") return finish(timer, NextResponse.json({ error: CONFIG_ERROR }, { status: 500 }), failure);
      if (err.kind === "no_materials") {
        return finish(timer, NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 }), failure);
      }
      const status = err.causeKind === "timeout" ? 504 : 502;
      return finish(timer, NextResponse.json({ error: GENERIC_ERROR }, { status }), failure);
    }
  }

  const result = await timer.measure("generation", () =>
    generateReviewV1({
      answers: validation.v1Answers,
      salonName: loadedSurvey.salonName,
      businessType: loadedSurvey.businessType ?? undefined,
      previousReview: parsed.previousReview,
    }),
  );
  if (!result.ok) {
    console.error("generate-review v1 failed", { salonId, kind: result.kind });
    record({ kind: "failed", pipeline: "v1", promptVersion: V1_PROMPT_VERSION, errorKind: result.kind });
    return finish(
      timer,
      NextResponse.json({ error: result.kind === "config" ? CONFIG_ERROR : GENERIC_ERROR }, { status: result.status }),
      { outcome: `failed:${result.kind}`, salonId, pipeline },
    );
  }
  record({
    kind,
    pipeline: "v1",
    promptVersion: V1_PROMPT_VERSION,
    model: result.model,
    latencyMs: result.latencyMs,
    llmCalls: result.attempts,
    // v1 の下書きも同じ Linter で数えて、v2 と比べられるようにする(本文は保存しない)。
    lintFlags: lintPlainDraft(result.review, materials),
    verifyMode: "none",
  });
  return finish(timer, NextResponse.json({ review: result.review, generationId }), { outcome: kind, salonId, pipeline });
}
