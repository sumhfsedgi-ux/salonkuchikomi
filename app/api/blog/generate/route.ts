import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { canAccessFeature } from "@/lib/access/featureAccess";
import { generateRequestSchema } from "@/lib/blog/validation";
import {
  getSalonSettings,
  getRecentPostsForVariety,
  getPost,
  createPost,
  updatePost,
  getStyleProfile,
  getReferencePostsByIds,
  ensureSalonSettingsRow,
  acquireGenerationLock,
  releaseGenerationLock,
} from "@/lib/blog/queries";
import { pickPatterns, type ForceExclude } from "@/lib/blog/variety";
import { deriveSeason } from "@/lib/blog/season";
import { callOpenAIJson, OpenAICallError } from "@/lib/blog/openai";
import { stripMarkdownArtifacts } from "@/lib/blog/textSanitize";
import {
  resolveLengthRange,
  buildStage1SystemPrompt,
  buildStage1UserPrompt,
  STAGE1_SCHEMA,
  buildStage2SystemPrompt,
  buildStage2UserPrompt,
  STAGE2_SCHEMA,
  buildLightEditSystemPrompt,
  buildLightEditUserPrompt,
  LIGHT_EDIT_SCHEMA,
  computeAdjustedTarget,
  type ResolvedLength,
  type LightEditMode,
} from "@/lib/blog/prompts";
import {
  GENERATION_PARAMS,
  GENERIC_GENERATION_ERROR,
  GENERATION_LOCKED_ERROR,
  INVALID_REQUEST_ERROR,
  HISTORY_LOOKBACK_FOR_VARIETY,
  HISTORY_EXCERPTS_FOR_PROMPT,
} from "@/lib/blog/config/blogRules";
import { REFERENCE_POSTS_IN_STAGE2_COUNT } from "@/lib/blog/config/hotpepper";
import type {
  BlogGenerationContext,
  BlogPost,
  LightEditResult,
  RecentPostSummary,
  SalonReferencePost,
  SalonStyleProfileData,
  Stage1Draft,
  Stage2Result,
  ThemeInput,
  LengthInput,
} from "@/lib/blog/types";
import type { PatternSelection } from "@/lib/blog/variety";

// Stage1+Stage2の2回のOpenAI呼び出しが直列で走るため、デフォルトの実行時間制限では
// 不足する可能性がある。60はVercel Hobbyプランの一般的な上限を前提にした値 --
// 実際のプロジェクト設定(Vercelダッシュボード → Settings → Functions)は
// 本番反映前に確認すること。GENERATION_PARAMSの各timeoutMsはこの60秒に
// 収まるよう余裕を持たせて調整済み(合計最悪55秒、config/blogRules.ts参照)。
export const runtime = "nodejs";
export const maxDuration = 60;

interface PipelineResult {
  title: string;
  body: string;
  pattern: PatternSelection;
  length: ResolvedLength;
}

interface StyleContext {
  profile: SalonStyleProfileData | null;
  referencePosts: Pick<SalonReferencePost, "body">[];
}

// Fisher-Yatesシャッフル。blog-app本来の `.sort(() => Math.random() - 0.5)` は
// 不正確な(一様でない)シャッフルだったため、review-app自身の
// app/api/generate-review/route.ts の pickRandomExamples と同じ正しい実装に揃えた。
function pickRandomSample<T>(items: T[], count: number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Style Profile（文体参照機能）が未生成のサロンでは、従来通りの生成結果になる
 * （グレースフルデグレード）。取得失敗時もブログ生成本体は止めない。
 */
async function loadStyleContext(salonId: string): Promise<StyleContext> {
  try {
    const profileRow = await getStyleProfile(salonId);
    if (!profileRow || profileRow.sourcePostIds.length === 0) {
      return { profile: null, referencePosts: [] };
    }
    const candidates = await getReferencePostsByIds(salonId, profileRow.sourcePostIds);
    return {
      profile: profileRow.profile,
      referencePosts: pickRandomSample(candidates, REFERENCE_POSTS_IN_STAGE2_COUNT),
    };
  } catch (err) {
    console.error("loadStyleContext failed, falling back to no style profile", err);
    return { profile: null, referencePosts: [] };
  }
}

/**
 * Stage2までの出力が文字数の許容範囲から外れていた場合のみ、既存の軽微調整
 * （lightEdit）の仕組みを再利用して1回だけ補正する。範囲内ならAPIを呼ばず素通り。
 * 失敗しても元の title/body をそのまま使う（生成自体は止めない）。
 */
async function correctLengthIfNeeded(opts: {
  salon: BlogGenerationContext;
  title: string;
  body: string;
  length: ResolvedLength;
}): Promise<{ title: string; body: string }> {
  const { salon, title, body, length } = opts;
  if (body.length >= length.min && body.length <= length.max) {
    return { title, body };
  }

  const mode: LightEditMode = body.length > length.max ? "shorten" : "detail";
  try {
    const corrected = await callOpenAIJson<LightEditResult>({
      systemPrompt: buildLightEditSystemPrompt(mode, length.target),
      userPrompt: buildLightEditUserPrompt({ salon, currentTitle: title, currentBody: body }),
      schema: LIGHT_EDIT_SCHEMA,
      ...GENERATION_PARAMS.lightEdit,
    });
    return { title: corrected.title, body: corrected.body };
  } catch (err) {
    console.error("correctLengthIfNeeded failed, keeping original length", err);
    return { title, body };
  }
}

async function runTwoStagePipeline(opts: {
  salon: BlogGenerationContext;
  theme: ThemeInput;
  lengthInput: LengthInput;
  recentForVariety: RecentPostSummary[];
  styleContext: StyleContext;
  forceExclude?: ForceExclude;
}): Promise<PipelineResult> {
  const season = deriveSeason(new Date());
  const length = resolveLengthRange(opts.lengthInput);
  const pattern = pickPatterns(opts.recentForVariety, opts.forceExclude);
  const recentForPrompt = opts.recentForVariety.slice(0, HISTORY_EXCERPTS_FOR_PROMPT);

  // 見出し・箇条書きをいつ使うかは「これから書く内容」を把握した時点での判断のため、
  // Style Profileは（Stage2だけでなく）下書きを書くStage1にも渡す。
  // 呼び出し元（POST）側でgetRecentPostsForVarietyと並列取得済みのため、
  // ここでは追加のレイテンシは発生しない。
  const stage1 = await callOpenAIJson<Stage1Draft>({
    systemPrompt: buildStage1SystemPrompt(),
    userPrompt: buildStage1UserPrompt({
      salon: opts.salon,
      season,
      theme: opts.theme,
      length,
      pattern,
      recentPosts: recentForPrompt,
      styleProfile: opts.styleContext.profile,
    }),
    schema: STAGE1_SCHEMA,
    ...GENERATION_PARAMS.stage1,
  });

  // stage1.meta はモデルの自己申告でありログ用途のみ。実際にDBへ書き込むのは
  // サーバー側が事前に選んだ pattern の方（下記参照）。
  console.info("stage1 self-reported meta:", stage1.meta, "server-selected pattern:", pattern);

  const stage2 = await callOpenAIJson<Stage2Result>({
    systemPrompt: buildStage2SystemPrompt(),
    userPrompt: buildStage2UserPrompt({
      draft: stage1,
      length,
      recentPosts: recentForPrompt,
      styleProfile: opts.styleContext.profile,
      referencePosts: opts.styleContext.referencePosts,
    }),
    schema: STAGE2_SCHEMA,
    ...GENERATION_PARAMS.stage2,
  });

  if (stage2.issuesFound.length > 0) {
    console.info("stage2 revised the draft:", stage2.issuesFound);
  }

  const corrected = await correctLengthIfNeeded({
    salon: opts.salon,
    title: stage2.title,
    body: stage2.body,
    length,
  });

  // Markdown記法は禁止をプロンプトで繰り返し指示しても一定確率で漏れるため、
  // 保存直前に機械的に除去する（lib/blog/textSanitize.ts参照）。
  return {
    title: stripMarkdownArtifacts(corrected.title),
    body: stripMarkdownArtifacts(corrected.body),
    pattern,
    length,
  };
}

function toGenerateResponse(post: BlogPost) {
  return {
    postId: post.id,
    title: post.title,
    body: post.body,
    meta: {
      structureType: post.structureType,
      openingStyle: post.openingStyle,
      endingStyle: post.endingStyle,
      themeCategory: post.themeCategory,
    },
    lengthType: post.lengthType,
    lengthTarget: post.lengthTarget,
  };
}

export async function POST(request: Request) {
  // 認証済みユーザー -> getCurrentSalon() -> salon.id の順で必ず解決する。
  // salonIdはリクエストボディ・クエリパラメータからは一切受け取らない
  // (generateRequestSchemaにもsalonIdフィールドは存在しない)。
  //
  // APP_MODE/店舗の契約プラン両方の許可を確認する(lib/access/featureAccess.ts)。
  // requireFeatureAccess()のnotFound()/redirect()はページ向けのため、ここでは
  // canAccessFeature()を直接使い、この経路の既存のJSONエラー契約を保つ。
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) {
    return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await canAccessFeature(salon, user.id, "blog"))) {
    return NextResponse.json({ error: "この機能は利用できません。" }, { status: 403 });
  }
  const salonId = salon.id;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: INVALID_REQUEST_ERROR }, { status: 400 });
  }

  const parsed = generateRequestSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("Invalid /api/blog/generate payload", parsed.error.flatten());
    return NextResponse.json({ error: INVALID_REQUEST_ERROR }, { status: 400 });
  }
  const body = parsed.data;

  // このサロンで初めてブログ機能を使う場合、salon_settingsにまだ行が無い。
  // 生成ロック(次のacquireGenerationLock)は既存行への.update()前提のため、
  // 先に行の存在を保証しておく(既存行があれば何もしない)。
  await ensureSalonSettingsRow(salonId);

  // サロン単位の排他ロック。同時に複数の生成が走ると、直近記事の重複回避判定
  // （pickPatterns）が互いの書き込み前の状態を見てしまいレースコンディションを起こすため。
  const lockAcquired = await acquireGenerationLock(salonId);
  if (!lockAcquired) {
    return NextResponse.json({ error: GENERATION_LOCKED_ERROR }, { status: 409 });
  }

  try {
    const salonSettings = await getSalonSettings(salonId);
    // ブログ生成AIへ渡すサロン情報は、SalonPack共通のサロン設定(salons、
    // getCurrentSalon()で解決済みのsalon)とブログ専用設定(salon_settings、
    // getSalonSettings())をサーバー側でここで合成する。店舗名・業種・店舗説明を
    // ブログ側で二重管理しない(クライアントからこれらの値を受け取ることもない)。
    const generationContext: BlogGenerationContext = {
      name: salon.name,
      businessType: salon.businessType,
      description: salon.description,
      mainMenu: salonSettings.mainMenu,
      specialties: salonSettings.specialties,
      targetCustomers: salonSettings.targetCustomers,
      commonConcerns: salonSettings.commonConcerns,
      salonTraits: salonSettings.salonTraits,
      tone: salonSettings.tone,
      emojiLevel: salonSettings.emojiLevel,
      avoidExpressions: salonSettings.avoidExpressions,
    };

    if (body.mode === "create") {
      const [recentForVariety, styleContext] = await Promise.all([
        getRecentPostsForVariety(salonId, HISTORY_LOOKBACK_FOR_VARIETY),
        loadStyleContext(salonId),
      ]);
      const result = await runTwoStagePipeline({
        salon: generationContext,
        theme: body.theme,
        lengthInput: body.length,
        recentForVariety,
        styleContext,
      });
      const post = await createPost({
        salonId,
        title: result.title,
        body: result.body,
        theme: body.theme.mode === "specified" ? body.theme.text : null,
        lengthType: result.length.lengthType,
        lengthTarget: result.length.target,
        structureType: result.pattern.structureType,
        openingStyle: result.pattern.openingStyle,
        endingStyle: result.pattern.endingStyle,
        themeCategory: result.pattern.themeCategory,
      });
      return NextResponse.json(toGenerateResponse(post));
    }

    if (body.mode === "regenerate") {
      const existing = await getPost(salonId, body.postId);
      if (!existing) {
        return NextResponse.json({ error: INVALID_REQUEST_ERROR }, { status: 404 });
      }
      const [recentForVariety, styleContext] = await Promise.all([
        getRecentPostsForVariety(salonId, HISTORY_LOOKBACK_FOR_VARIETY),
        loadStyleContext(salonId),
      ]);
      const forceExclude: ForceExclude = {
        structureType: [existing.structureType],
        openingStyle: [existing.openingStyle],
        endingStyle: [existing.endingStyle],
        themeCategory: body.theme.mode === "omakase" ? [existing.themeCategory] : [],
      };
      const result = await runTwoStagePipeline({
        salon: generationContext,
        theme: body.theme,
        lengthInput: body.length,
        recentForVariety,
        forceExclude,
        styleContext,
      });
      const post = await updatePost(salonId, existing.id, {
        title: result.title,
        body: result.body,
        theme: body.theme.mode === "specified" ? body.theme.text : null,
        lengthType: result.length.lengthType,
        lengthTarget: result.length.target,
        structureType: result.pattern.structureType,
        openingStyle: result.pattern.openingStyle,
        endingStyle: result.pattern.endingStyle,
        themeCategory: result.pattern.themeCategory,
      });
      return NextResponse.json(toGenerateResponse(post));
    }

    // shorten / soften / detail: 軽量な単発編集。構成系カラムは変更しない。
    const existing = await getPost(salonId, body.postId);
    if (!existing) {
      return NextResponse.json({ error: INVALID_REQUEST_ERROR }, { status: 404 });
    }
    const newTarget = computeAdjustedTarget(body.mode, body.currentBody.length);
    const lightResult = await callOpenAIJson<LightEditResult>({
      systemPrompt: buildLightEditSystemPrompt(body.mode, newTarget),
      userPrompt: buildLightEditUserPrompt({
        salon: generationContext,
        currentTitle: body.currentTitle,
        currentBody: body.currentBody,
      }),
      schema: LIGHT_EDIT_SCHEMA,
      ...GENERATION_PARAMS.lightEdit,
    });
    const post = await updatePost(salonId, existing.id, {
      title: stripMarkdownArtifacts(lightResult.title),
      body: stripMarkdownArtifacts(lightResult.body),
      lengthTarget: newTarget,
    });
    return NextResponse.json(toGenerateResponse(post));
  } catch (err) {
    console.error("/api/blog/generate failed", err);
    if (err instanceof OpenAICallError) {
      const status = err.kind === "timeout" ? 504 : err.kind === "config" ? 500 : 502;
      return NextResponse.json({ error: GENERIC_GENERATION_ERROR }, { status });
    }
    return NextResponse.json({ error: GENERIC_GENERATION_ERROR }, { status: 500 });
  } finally {
    await releaseGenerationLock(salonId);
  }
}
