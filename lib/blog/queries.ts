// ブログ機能のDBクエリ層。すべての関数は salonId を明示引数として受け取る
// （呼び出し元がクライアント入力ではなく、認証済みセッションから解決した
// SalonPackの salons.id を渡す。lib/supabase/queries.ts の getCurrentSalon 参照）。
// (blog-appの lib/supabase/queries.ts を移植。import pathとadminクライアント名のみ変更)
import { getBlogSupabaseAdmin } from "@/lib/blog/admin";
import { DEFAULT_SALON_SETTINGS, type SalonSettings } from "@/lib/blog/config/salon";
import type {
  StructureTypeId,
  OpeningStyleId,
  EndingStyleId,
  ThemeCategoryId,
  LengthType,
} from "@/lib/blog/config/blogRules";
import type {
  BlogPost,
  BlogPostSummary,
  RecentPostSummary,
  SalonReferencePost,
  SalonStyleProfile,
  SalonStyleProfileData,
} from "@/lib/blog/types";
import type { NewReferencePostInput } from "@/lib/blog/hotpepper/scraper";

interface SalonSettingsRow {
  salon_id: string;
  main_menu: string[];
  specialties: string[];
  target_customers: string[];
  common_concerns: string[];
  salon_traits: string;
  tone: string;
  emoji_level: string;
  avoid_expressions: string | null;
  hotpepper_blog_url: string | null;
}

function rowToSalonSettings(row: SalonSettingsRow): SalonSettings {
  return {
    salonId: row.salon_id,
    mainMenu: row.main_menu ?? [],
    specialties: row.specialties ?? [],
    targetCustomers: row.target_customers ?? [],
    commonConcerns: row.common_concerns ?? [],
    salonTraits: row.salon_traits,
    tone: row.tone as SalonSettings["tone"],
    emojiLevel: row.emoji_level as SalonSettings["emojiLevel"],
    avoidExpressions: row.avoid_expressions,
    hotpepperBlogUrl: row.hotpepper_blog_url,
  };
}

export async function getSalonSettings(salonId: string): Promise<SalonSettings> {
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase
    .from("salon_settings")
    .select(
      "salon_id, main_menu, specialties, target_customers, common_concerns, salon_traits, tone, emoji_level, avoid_expressions, hotpepper_blog_url"
    )
    .eq("salon_id", salonId)
    .maybeSingle();

  if (error) {
    console.error("getSalonSettings failed:", error);
    throw new Error("サロン設定の取得に失敗しました。");
  }

  if (!data) {
    // 設定行がまだ無くても生成自体は動く必要があるため、既定値へフォールバックする。
    return { ...DEFAULT_SALON_SETTINGS, salonId };
  }

  return rowToSalonSettings(data);
}

export async function upsertSalonSettings(
  salonId: string,
  // hotpepperBlogUrlは一般設定フォームからは編集させず、
  // updateHotPepperBlogUrl()経由でのみ更新する（単一責任のため、ここでは対象外にする）。
  settings: Omit<SalonSettings, "salonId" | "hotpepperBlogUrl">
): Promise<void> {
  const supabase = getBlogSupabaseAdmin();
  const { error } = await supabase.from("salon_settings").upsert(
    {
      salon_id: salonId,
      main_menu: settings.mainMenu,
      specialties: settings.specialties,
      target_customers: settings.targetCustomers,
      common_concerns: settings.commonConcerns,
      salon_traits: settings.salonTraits,
      tone: settings.tone,
      emoji_level: settings.emojiLevel,
      avoid_expressions: settings.avoidExpressions,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "salon_id" }
  );

  if (error) {
    console.error("upsertSalonSettings failed:", error);
    throw new Error("サロン設定の保存に失敗しました。");
  }
}

interface BlogPostRow {
  id: string;
  salon_id: string;
  title: string;
  body: string;
  theme: string | null;
  length_type: string;
  length_target: number;
  structure_type: string;
  opening_style: string;
  ending_style: string;
  theme_category: string;
  created_at: string;
  updated_at: string;
}

function rowToBlogPost(row: BlogPostRow): BlogPost {
  return {
    id: row.id,
    salonId: row.salon_id,
    title: row.title,
    body: row.body,
    theme: row.theme,
    lengthType: row.length_type as LengthType,
    lengthTarget: row.length_target,
    structureType: row.structure_type as StructureTypeId,
    openingStyle: row.opening_style as OpeningStyleId,
    endingStyle: row.ending_style as EndingStyleId,
    themeCategory: row.theme_category as ThemeCategoryId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BLOG_POST_COLUMNS =
  "id, salon_id, title, body, theme, length_type, length_target, structure_type, opening_style, ending_style, theme_category, created_at, updated_at";

/**
 * 履歴一覧専用。一覧表示はタイトル・テーマ・日付しか使わないため、
 * 本文を含む全カラムは取得しない（記事が増えるほど無駄な転送量が線形に増えるため）。
 * 本文が必要な詳細表示は getPost() を使う。
 */
export async function listPosts(salonId: string, limit = 200): Promise<BlogPostSummary[]> {
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase
    .from("blog_posts")
    .select("id, title, theme, created_at")
    .eq("salon_id", salonId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("listPosts failed:", error);
    throw new Error("過去の記事の取得に失敗しました。");
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    theme: row.theme,
    createdAt: row.created_at,
  }));
}

export async function getPost(salonId: string, id: string): Promise<BlogPost | null> {
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase
    .from("blog_posts")
    .select(BLOG_POST_COLUMNS)
    .eq("salon_id", salonId)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("getPost failed:", error);
    throw new Error("記事の取得に失敗しました。");
  }

  return data ? rowToBlogPost(data) : null;
}

export interface CreatePostInput {
  salonId: string;
  title: string;
  body: string;
  theme: string | null;
  lengthType: LengthType;
  lengthTarget: number;
  structureType: StructureTypeId;
  openingStyle: OpeningStyleId;
  endingStyle: EndingStyleId;
  themeCategory: ThemeCategoryId;
}

export async function createPost(input: CreatePostInput): Promise<BlogPost> {
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase
    .from("blog_posts")
    .insert({
      salon_id: input.salonId,
      title: input.title,
      body: input.body,
      theme: input.theme,
      length_type: input.lengthType,
      length_target: input.lengthTarget,
      structure_type: input.structureType,
      opening_style: input.openingStyle,
      ending_style: input.endingStyle,
      theme_category: input.themeCategory,
    })
    .select(BLOG_POST_COLUMNS)
    .single();

  if (error || !data) {
    console.error("createPost failed:", error);
    throw new Error("記事の保存に失敗しました。");
  }

  return rowToBlogPost(data);
}

export type UpdatePostInput = Partial<
  Omit<CreatePostInput, "salonId">
>;

export async function updatePost(
  salonId: string,
  id: string,
  input: UpdatePostInput
): Promise<BlogPost> {
  const supabase = getBlogSupabaseAdmin();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  if (input.theme !== undefined) patch.theme = input.theme;
  if (input.lengthType !== undefined) patch.length_type = input.lengthType;
  if (input.lengthTarget !== undefined) patch.length_target = input.lengthTarget;
  if (input.structureType !== undefined) patch.structure_type = input.structureType;
  if (input.openingStyle !== undefined) patch.opening_style = input.openingStyle;
  if (input.endingStyle !== undefined) patch.ending_style = input.endingStyle;
  if (input.themeCategory !== undefined) patch.theme_category = input.themeCategory;

  const { data, error } = await supabase
    .from("blog_posts")
    .update(patch)
    .eq("salon_id", salonId)
    .eq("id", id)
    .select(BLOG_POST_COLUMNS)
    .single();

  if (error || !data) {
    console.error("updatePost failed:", error);
    throw new Error("記事の更新に失敗しました。");
  }

  return rowToBlogPost(data);
}

export async function deletePost(salonId: string, id: string): Promise<void> {
  const supabase = getBlogSupabaseAdmin();
  const { error } = await supabase
    .from("blog_posts")
    .delete()
    .eq("salon_id", salonId)
    .eq("id", id);

  if (error) {
    console.error("deletePost failed:", error);
    throw new Error("記事の削除に失敗しました。");
  }
}

function excerpt(text: string, length: number): string {
  const trimmed = text.trim();
  return trimmed.length <= length ? trimmed : trimmed.slice(0, length);
}

function endExcerpt(text: string, length: number): string {
  const trimmed = text.trim();
  return trimmed.length <= length ? trimmed : trimmed.slice(-length);
}

interface RecentPostExcerptRow {
  title: string;
  opening_excerpt: string;
  ending_excerpt: string;
  structure_type: string;
  opening_style: string;
  ending_style: string;
  theme_category: string;
}

/**
 * バラエティ選定・重複回避のために直近の記事を取得する。
 * 本文全文は呼び出し元に渡さず、冒頭/末尾の抜粋のみを返す
 * （プロンプトのトークン削減と、過去記事の丸写し防止を両立させるため）。
 * 抜粋の切り出し自体もDB側の関数（get_recent_post_excerpts）で行い、
 * 本文全文をアプリ側へ転送しない。
 */
export async function getRecentPostsForVariety(
  salonId: string,
  limit: number
): Promise<RecentPostSummary[]> {
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase.rpc("get_recent_post_excerpts", {
    p_salon_id: salonId,
    p_limit: limit,
  });

  if (error) {
    console.error("getRecentPostsForVariety failed:", error);
    throw new Error("直近記事の取得に失敗しました。");
  }

  return ((data ?? []) as RecentPostExcerptRow[]).map((row) => ({
    title: row.title,
    openingExcerpt: excerpt(row.opening_excerpt, 40),
    endingExcerpt: endExcerpt(row.ending_excerpt, 40),
    structureType: row.structure_type as StructureTypeId,
    openingStyle: row.opening_style as OpeningStyleId,
    endingStyle: row.ending_style as EndingStyleId,
    themeCategory: row.theme_category as ThemeCategoryId,
  }));
}

// ---------------------------------------------------------------------------
// 文体参照機能: Hot Pepper Beautyから取り込んだ参考記事（salon_reference_posts）と
// サロンの文体プロファイル（salon_style_profiles）。
// blog_posts（AI生成記事、重複回避用）とは目的も参照テーブルも別物。
// ---------------------------------------------------------------------------

export async function updateHotPepperBlogUrl(salonId: string, url: string | null): Promise<void> {
  const supabase = getBlogSupabaseAdmin();
  // salon_settingsは常に1行存在する前提（upsertSalonSettings経由で作られる）ため単純なpartial updateでよい。
  const { error } = await supabase
    .from("salon_settings")
    .update({ hotpepper_blog_url: url, updated_at: new Date().toISOString() })
    .eq("salon_id", salonId);

  if (error) {
    console.error("updateHotPepperBlogUrl failed:", error);
    throw new Error("Hot PepperブログURLの保存に失敗しました。");
  }
}

interface SalonReferencePostRow {
  id: string;
  salon_id: string;
  source: string;
  source_url: string;
  title: string;
  body: string;
  author_name: string | null;
  posted_at: string | null;
  use_for_style: boolean;
  imported_at: string;
  created_at: string;
  updated_at: string;
}

function rowToReferencePost(row: SalonReferencePostRow): SalonReferencePost {
  return {
    id: row.id,
    salonId: row.salon_id,
    source: row.source as SalonReferencePost["source"],
    sourceUrl: row.source_url,
    title: row.title,
    body: row.body,
    authorName: row.author_name,
    postedAt: row.posted_at,
    useForStyle: row.use_for_style,
    importedAt: row.imported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const REFERENCE_POST_COLUMNS =
  "id, salon_id, source, source_url, title, body, author_name, posted_at, use_for_style, imported_at, created_at, updated_at";

export async function listReferencePosts(
  salonId: string,
  opts: { onlySelected?: boolean } = {}
): Promise<SalonReferencePost[]> {
  const supabase = getBlogSupabaseAdmin();
  let query = supabase
    .from("salon_reference_posts")
    .select(REFERENCE_POST_COLUMNS)
    .eq("salon_id", salonId);

  if (opts.onlySelected) {
    query = query.eq("use_for_style", true);
  }

  const { data, error } = await query
    .order("posted_at", { ascending: false, nullsFirst: false })
    .order("imported_at", { ascending: false });

  if (error) {
    console.error("listReferencePosts failed:", error);
    throw new Error("参考記事の取得に失敗しました。");
  }

  return (data ?? []).map(rowToReferencePost);
}

/** インポート時の重複取得回避に使う、既存source_urlの集合。 */
export async function listReferencePostSourceUrls(salonId: string): Promise<Set<string>> {
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase
    .from("salon_reference_posts")
    .select("source_url")
    .eq("salon_id", salonId);

  if (error) {
    console.error("listReferencePostSourceUrls failed:", error);
    throw new Error("参考記事の取得に失敗しました。");
  }

  return new Set((data ?? []).map((row) => row.source_url));
}

export async function bulkInsertReferencePosts(
  salonId: string,
  posts: NewReferencePostInput[]
): Promise<void> {
  if (posts.length === 0) return;
  const supabase = getBlogSupabaseAdmin();
  const { error } = await supabase.from("salon_reference_posts").upsert(
    posts.map((post) => ({
      salon_id: salonId,
      source: "hotpepper" as const,
      source_url: post.sourceUrl,
      title: post.title,
      body: post.body,
      author_name: post.authorName,
      posted_at: post.postedAt,
    })),
    // 事前にlistReferencePostSourceUrls()で重複チェック済みだが、並行実行時の
    // 競合に対する多層防御としてonConflictでも無視する。
    { onConflict: "salon_id,source_url", ignoreDuplicates: true }
  );

  if (error) {
    console.error("bulkInsertReferencePosts failed:", error);
    throw new Error("参考記事の保存に失敗しました。");
  }
}

export async function setReferencePostUseForStyle(
  salonId: string,
  id: string,
  useForStyle: boolean
): Promise<void> {
  const supabase = getBlogSupabaseAdmin();
  const { error } = await supabase
    .from("salon_reference_posts")
    .update({ use_for_style: useForStyle, updated_at: new Date().toISOString() })
    .eq("salon_id", salonId)
    .eq("id", id);

  if (error) {
    console.error("setReferencePostUseForStyle failed:", error);
    throw new Error("参考記事の更新に失敗しました。");
  }
}

export async function getReferencePostsByIds(
  salonId: string,
  ids: string[]
): Promise<SalonReferencePost[]> {
  if (ids.length === 0) return [];
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase
    .from("salon_reference_posts")
    .select(REFERENCE_POST_COLUMNS)
    .eq("salon_id", salonId)
    .in("id", ids);

  if (error) {
    console.error("getReferencePostsByIds failed:", error);
    throw new Error("参考記事の取得に失敗しました。");
  }

  return (data ?? []).map(rowToReferencePost);
}

interface SalonStyleProfileRow {
  salon_id: string;
  // jsonbのためスキーマ強制が無く、旧バージョンで生成された行は新フィールドを
  // 丸ごと持たない可能性がある。Partialにして、下記のマージが必須であることを
  // 型上も明確にする。
  profile: Partial<SalonStyleProfileData>;
  source_post_ids: string[];
  generated_at: string | null;
  updated_at: string;
}

// 見出し・箇条書き分析（headingStyle/listStyle/compositionPattern）や
// 絵文字・顔文字・装飾記号・句読点分析（emojiStyle/kaomojiStyle/
// decorativeSymbolStyle/punctuationStyle）の追加前に生成された古いプロファイル行を
// 安全に読めるようにするための既定値。upsertStyleProfile()は常に全項目そろった
// 新形式で丸ごと上書きするため、「一部のフィールドだけ古い」状態は起こり得ず、
// これらのキーが丸ごと無いケースだけを考えればよい（shallow mergeで十分）。
const DEFAULT_STYLE_EXTENSIONS: Pick<
  SalonStyleProfileData,
  | "headingStyle"
  | "listStyle"
  | "compositionPattern"
  | "emojiStyle"
  | "kaomojiStyle"
  | "decorativeSymbolStyle"
  | "punctuationStyle"
> = {
  headingStyle: { usesHeadings: false, preferredSymbols: [], usage: "" },
  listStyle: { usesBulletLists: false, usesNumberedLists: false, preferredBullets: [], commonUseCases: [] },
  compositionPattern: "",
  emojiStyle: { level: "特になし", preferred: [], frequency: "特になし", usage: "特になし" },
  kaomojiStyle: { usesKaomoji: false, preferred: [], frequency: "特になし", usage: "特になし" },
  decorativeSymbolStyle: { usesSymbols: false, preferred: [], usageNotes: [], frequency: "特になし" },
  punctuationStyle: { commonSentenceEndings: [], tendency: "特になし" },
};

export async function getStyleProfile(salonId: string): Promise<SalonStyleProfile | null> {
  const supabase = getBlogSupabaseAdmin();
  const { data, error } = await supabase
    .from("salon_style_profiles")
    .select("salon_id, profile, source_post_ids, generated_at, updated_at")
    .eq("salon_id", salonId)
    .maybeSingle();

  if (error) {
    console.error("getStyleProfile failed:", error);
    throw new Error("文体プロファイルの取得に失敗しました。");
  }
  if (!data) return null;

  const row = data as SalonStyleProfileRow;
  // profile が空(未生成時の既定値 '{}')の場合はプロファイル未生成として扱う。
  if (!row.generated_at) return null;

  return {
    salonId: row.salon_id,
    profile: { ...DEFAULT_STYLE_EXTENSIONS, ...row.profile } as SalonStyleProfileData,
    sourcePostIds: row.source_post_ids ?? [],
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

// "#"はMarkdownの見出し記法そのものであり、これをStage1へ「このサロンが使う見出し記号」
// として渡すと「Markdownは一切使わない」という別のルールと矛盾し、出力への#混入を招く。
// Style Profile生成AIがSNSのハッシュタグ等を見出し記号と誤認して報告してくることがあるため、
// プロンプト側の指示だけに頼らず、保存時に確実に取り除く。
const MARKDOWN_HEADING_SYMBOLS = new Set(["#", "##", "###"]);

// 絵文字・顔文字・装飾記号・文末表現としてAIが報告してくる値にMarkdown記法の記号
// （*, -, _, `など）が紛れ込むと、「学習した記号だから使ってよい」という
// Stage1側の許可ルールとMarkdown禁止ルールが矛盾し、意図せずMarkdown風の
// 出力を招く。プロンプト側の指示だけに頼らず、保存時に確実に取り除く。
const MARKDOWN_CONFLICTING_SYMBOLS = new Set(["#", "##", "###", "*", "**", "_", "__", "-", "`"]);

/** 本物のUnicode絵文字は必ずASCII範囲外の文字を含む。"^ ^"のような顔文字の断片が
 * emojiStyleに誤分類された場合、ASCII文字のみで構成される値として機械的に検出できる。 */
function isAsciiOnly(s: string): boolean {
  return /^[\x00-\x7F]*$/.test(s);
}

function sanitizeStyleProfile(profile: SalonStyleProfileData): SalonStyleProfileData {
  // decorativeSymbolStyle/kaomojiStyleの方がより具体的なカテゴリのため、
  // emojiStyleと重複する記号（プロンプトの指示ミス等で両方に分類された場合）は
  // emojiStyle側から取り除く。
  const decorativePreferred = new Set(
    profile.decorativeSymbolStyle.preferred.map((s) => s.trim())
  );
  const kaomojiPreferred = new Set(profile.kaomojiStyle.preferred.map((s) => s.trim()));

  return {
    ...profile,
    headingStyle: {
      ...profile.headingStyle,
      preferredSymbols: profile.headingStyle.preferredSymbols.filter(
        (s) => !MARKDOWN_HEADING_SYMBOLS.has(s.trim())
      ),
    },
    emojiStyle: {
      ...profile.emojiStyle,
      preferred: profile.emojiStyle.preferred.filter(
        (s) =>
          !MARKDOWN_CONFLICTING_SYMBOLS.has(s.trim()) &&
          !isAsciiOnly(s) &&
          !decorativePreferred.has(s.trim()) &&
          !kaomojiPreferred.has(s.trim())
      ),
    },
    kaomojiStyle: {
      ...profile.kaomojiStyle,
      preferred: profile.kaomojiStyle.preferred.filter((s) => !MARKDOWN_CONFLICTING_SYMBOLS.has(s.trim())),
    },
    decorativeSymbolStyle: {
      ...profile.decorativeSymbolStyle,
      preferred: profile.decorativeSymbolStyle.preferred.filter(
        (s) => !MARKDOWN_CONFLICTING_SYMBOLS.has(s.trim())
      ),
      usageNotes: profile.decorativeSymbolStyle.usageNotes.filter(
        (n) => !MARKDOWN_CONFLICTING_SYMBOLS.has(n.symbol.trim())
      ),
    },
    punctuationStyle: {
      ...profile.punctuationStyle,
      commonSentenceEndings: profile.punctuationStyle.commonSentenceEndings.filter(
        (s) => !MARKDOWN_CONFLICTING_SYMBOLS.has(s.trim())
      ),
    },
  };
}

export async function upsertStyleProfile(
  salonId: string,
  input: { profile: SalonStyleProfileData; sourcePostIds: string[] }
): Promise<void> {
  const supabase = getBlogSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase.from("salon_style_profiles").upsert(
    {
      salon_id: salonId,
      profile: sanitizeStyleProfile(input.profile),
      source_post_ids: input.sourcePostIds,
      generated_at: now,
      updated_at: now,
    },
    { onConflict: "salon_id" }
  );

  if (error) {
    console.error("upsertStyleProfile failed:", error);
    throw new Error("文体プロファイルの保存に失敗しました。");
  }
}

// ---------------------------------------------------------------------------
// 生成リクエストの排他ロック（サロン単位）。同時に複数の生成が走ると、
// pickPatterns()の重複回避判定が互いの書き込み前の状態を見てしまい、
// 直近記事と同じ構成が連続してしまうことがある（実機検証で確認済み）。
// ---------------------------------------------------------------------------

// maxDuration(60秒)より長めに取り、正常終了時にfinallyでの解放漏れが起きても
// 一定時間後には自動的にロックが解除されるようにする安全弁。
const GENERATION_LOCK_STALE_MS = 90_000;

/**
 * blog-app(単一サロン)ではschema.sqlのseedで salon_settings に 'default' 行が
 * 必ず1件存在した。SalonPack統合後は新しいサロンごとに行が存在しない状態から
 * 始まるため、acquireGenerationLock等の`.update()`(行が無ければ0件ヒットで
 * 静かに空振りする)を呼ぶ前に、必ず1回だけこれを呼んで行の存在を保証する。
 * 既に行がある場合は何もしない(on conflict do nothing相当)。
 */
export async function ensureSalonSettingsRow(salonId: string): Promise<void> {
  const supabase = getBlogSupabaseAdmin();
  const { error } = await supabase
    .from("salon_settings")
    .upsert({ salon_id: salonId }, { onConflict: "salon_id", ignoreDuplicates: true });

  if (error) {
    console.error("ensureSalonSettingsRow failed:", error);
    throw new Error("サロン設定の初期化に失敗しました。");
  }
}

/** ロック取得に成功したら true。既に他の生成が進行中なら false。 */
export async function acquireGenerationLock(salonId: string): Promise<boolean> {
  const supabase = getBlogSupabaseAdmin();
  const staleThreshold = new Date(Date.now() - GENERATION_LOCK_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from("salon_settings")
    .update({ generation_locked_at: new Date().toISOString() })
    .eq("salon_id", salonId)
    .or(`generation_locked_at.is.null,generation_locked_at.lt.${staleThreshold}`)
    .select("salon_id");

  if (error) {
    console.error("acquireGenerationLock failed:", error);
    // ロック機構自体の障害でブログ生成自体を止めない（フェイルオープン）。
    return true;
  }
  return (data?.length ?? 0) > 0;
}

export async function releaseGenerationLock(salonId: string): Promise<void> {
  const supabase = getBlogSupabaseAdmin();
  const { error } = await supabase
    .from("salon_settings")
    .update({ generation_locked_at: null })
    .eq("salon_id", salonId);

  if (error) {
    // 解放に失敗してもGENERATION_LOCK_STALE_MS経過後に自動解除されるため致命的ではない。
    console.error("releaseGenerationLock failed:", error);
  }
}
