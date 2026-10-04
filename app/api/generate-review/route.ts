import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateReviewV1 } from "@/lib/reviewGeneration/legacyV1";
import { buildMaterials } from "@/lib/reviewGeneration/materials";
import { ReviewGenerationError, runReviewPipeline } from "@/lib/reviewGeneration/pipeline";
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

// REVIEW_PIPELINE=v2 のときだけ v2 を使う(未設定・それ以外は v1)。v1 に戻すときは
// この環境変数を外して再デプロイする(docs/plans/reviews-465-plan.md §13-5)。
function pipelineVersion(): "v1" | "v2" {
  return process.env.REVIEW_PIPELINE?.trim() === "v2" ? "v2" : "v1";
}

// 回答・生成した文章はログに出さない(salonId と種類・状態だけを出す)。
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 });
  }

  const parsed = parseGenerateRequest(body);
  if (!parsed) {
    console.error("Invalid generate-review payload");
    return NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 });
  }
  const { salonId } = parsed;

  let survey;
  try {
    survey = await loadActiveSurvey(await createClient(), salonId);
  } catch {
    console.error("generate-review: failed to load survey", { salonId });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 503 });
  }
  if (!survey) {
    return NextResponse.json({ error: "店舗またはアンケートが見つかりません。" }, { status: 404 });
  }

  const validation = validateAnswers(survey, parsed.answers);
  if (!validation.ok) {
    if (validation.reason === "stale") {
      return NextResponse.json({ error: STALE_ERROR }, { status: 409 });
    }
    console.error("generate-review: invalid answers", { salonId, reason: validation.reason });
    return NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 });
  }

  const generationId = crypto.randomUUID();

  if (pipelineVersion() === "v2") {
    try {
      const result = await runReviewPipeline({
        materials: buildMaterials(validation.inputs),
        businessType: survey.businessType,
        previousPlan: parsed.previousPlan,
      });
      const { mainIds, supportIds, length, opening, closing } = result.plan;
      return NextResponse.json({
        review: result.draft,
        generationId,
        plan: { mainIds, supportIds, length, opening, closing },
      });
    } catch (err) {
      if (!(err instanceof ReviewGenerationError)) {
        console.error("generate-review v2: unexpected error", { salonId });
        return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
      }
      console.error("generate-review v2 failed", { salonId, kind: err.kind, cause: err.causeKind });
      if (err.kind === "config") return NextResponse.json({ error: CONFIG_ERROR }, { status: 500 });
      if (err.kind === "no_materials") return NextResponse.json({ error: BAD_REQUEST_ERROR }, { status: 400 });
      const status = err.causeKind === "timeout" ? 504 : 502;
      return NextResponse.json({ error: GENERIC_ERROR }, { status });
    }
  }

  const result = await generateReviewV1({
    answers: validation.v1Answers,
    salonName: survey.salonName,
    businessType: survey.businessType ?? undefined,
    previousReview: parsed.previousReview,
  });
  if (!result.ok) {
    console.error("generate-review v1 failed", { salonId, kind: result.kind });
    return NextResponse.json(
      { error: result.kind === "config" ? CONFIG_ERROR : GENERIC_ERROR },
      { status: result.status },
    );
  }
  return NextResponse.json({ review: result.review, generationId });
}
