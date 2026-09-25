// AIっぽさを消すための生成ルールは、ここでプロンプト文字列として一箇所にまとめる。
// サロン固有の値は引数として受け取るだけで、業種ごとの分岐はここには書かない。
// (blog-appの lib/prompts.ts を無変更で移植、import pathのみ更新)

import {
  SOFT_BANNED_PHRASES,
  LENGTH_PRESETS,
  CUSTOM_LENGTH_BOUNDS,
  getStructureType,
  getOpeningStyle,
  getEndingStyle,
  getThemeCategory,
  STRUCTURE_TYPE_IDS,
  OPENING_STYLE_IDS,
  ENDING_STYLE_IDS,
  THEME_CATEGORY_IDS,
  type LengthType,
} from "@/lib/blog/config/blogRules";
import {
  REFERENCE_POST_EXCERPT_MAX_CHARS,
  STYLE_PROFILE_SOURCE_BODY_TRUNCATE,
} from "@/lib/blog/config/hotpepper";
import type { PatternSelection } from "@/lib/blog/variety";
import type {
  RecentPostSummary,
  ThemeInput,
  LengthInput,
  Stage1Draft,
  SalonReferencePost,
  SalonStyleProfileData,
  BlogGenerationContext,
} from "@/lib/blog/types";
import type { JsonSchemaSpec } from "@/lib/blog/openai";
import type { Season } from "@/lib/blog/season";

export interface ResolvedLength {
  lengthType: LengthType;
  target: number;
  min: number;
  max: number;
}

export function resolveLengthRange(length: LengthInput): ResolvedLength {
  if (length.type === "custom") {
    const target = Math.min(
      Math.max(Math.round(length.target), CUSTOM_LENGTH_BOUNDS.min),
      CUSTOM_LENGTH_BOUNDS.max
    );
    // カスタムは目標値の前後20%程度を許容範囲として扱う。
    const min = Math.max(CUSTOM_LENGTH_BOUNDS.min, Math.round(target * 0.8));
    const max = Math.min(CUSTOM_LENGTH_BOUNDS.max, Math.round(target * 1.2));
    return { lengthType: "custom", target, min, max };
  }
  const preset = LENGTH_PRESETS[length.type];
  return { lengthType: length.type, target: preset.target, min: preset.min, max: preset.max };
}

// businessType/descriptionはSalonPack共通のサロン設定から来るため空(null)のことが
// あり得る。他の項目のように「未設定」と書かず、値が無い行はそのまま省略する
// (AIへ「未設定」という無意味な事実を渡さないため)。
function buildSalonInfoBlock(salon: BlogGenerationContext): string {
  const lines = [
    `店舗名: ${salon.name}`,
    salon.businessType ? `業種: ${salon.businessType}` : null,
    salon.description ? `店舗説明: ${salon.description}` : null,
    `主なメニュー: ${salon.mainMenu.length ? salon.mainMenu.join("、") : "未設定"}`,
    `得意な施術・サービス: ${salon.specialties.length ? salon.specialties.join("、") : "未設定"}`,
    `ターゲット層: ${salon.targetCustomers.length ? salon.targetCustomers.join("、") : "未設定"}`,
    `よくあるお客様の悩み: ${salon.commonConcerns.length ? salon.commonConcerns.join("、") : "未設定"}`,
    `サロンの特徴・強み: ${salon.salonTraits || "未設定"}`,
    `文章の雰囲気: ${salon.tone}`,
    `絵文字の使用量: ${salon.emojiLevel}`,
    `避けたい表現: ${salon.avoidExpressions || "なし"}`,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function buildRecentPostsBlock(recentPosts: RecentPostSummary[]): string {
  if (recentPosts.length === 0) return "（まだ記事がありません）";
  return recentPosts
    .map((p) => `- タイトル:「${p.title}」 / 書き出し:「${p.openingExcerpt}…」 / 締め:「…${p.endingExcerpt}」`)
    .join("\n");
}

function buildBannedPhrasesList(): string {
  return SOFT_BANNED_PHRASES.map((p) => `・「${p}」`).join("\n");
}

function buildSalonStyleProfileBlock(profile: SalonStyleProfileData): string {
  return `文章のトーン: ${profile.tone}
一文の長さ: ${profile.sentenceLength}
敬語レベル: ${profile.politeness}
絵文字の使用量: ${profile.emojiLevel}
改行の入れ方: ${profile.lineBreakStyle}
締め方の傾向: ${profile.endingStyle}
よく使う表現: ${profile.commonExpressions.length ? profile.commonExpressions.join("、") : "特になし"}
避けるべき表現: ${profile.avoidExpressions.length ? profile.avoidExpressions.join("、") : "特になし"}
${buildStyleStructureBlock(profile)}
${buildStyleExpressionBlock(profile)}`;
}

/**
 * 見出し・箇条書き・記事全体の構成パターンなど「構造・見せ方」の傾向だけを
 * テキスト化する。Stage1（下書き生成の判断材料）とStage2（検証）の両方から使う。
 */
function buildStyleStructureBlock(profile: SalonStyleProfileData): string {
  const heading = profile.headingStyle;
  const list = profile.listStyle;
  return `小見出しの使用: ${
    heading.usesHeadings
      ? `使う（記号: ${heading.preferredSymbols.join("、") || "特になし"}／用途: ${heading.usage}）`
      : "使わない"
  }
箇条書きの使用: ${
    list.usesBulletLists
      ? `使う（記号: ${list.preferredBullets.join("、") || "・"}／よく使う場面: ${
          list.commonUseCases.length ? list.commonUseCases.join("、") : "特になし"
        }）`
      : "使わない"
  }
番号付きリストの使用: ${list.usesNumberedLists ? "使う" : "使わない"}
記事の典型的な構成パターン: ${profile.compositionPattern || "特になし"}`;
}

/**
 * 絵文字・顔文字・装飾記号・文末の句読点のクセなど「表現の装飾」の傾向だけを
 * テキスト化する。Stage1（下書き生成の判断材料）とStage2（検証）の両方から使う。
 * カテゴリを混同しない（♪★等の装飾記号と(^O^)等の顔文字と😊等の絵文字は別物）。
 */
function buildStyleExpressionBlock(profile: SalonStyleProfileData): string {
  const emoji = profile.emojiStyle;
  const kaomoji = profile.kaomojiStyle;
  const decorative = profile.decorativeSymbolStyle;
  const punctuation = profile.punctuationStyle;
  const decorativeUsage = decorative.usageNotes.length
    ? decorative.usageNotes.map((n) => `${n.symbol}: ${n.usage}`).join("、")
    : "特になし";
  return `絵文字（Unicode絵文字）の使用量: ${emoji.level}（記号: ${
    emoji.preferred.join("、") || "特になし"
  }／頻度目安: ${emoji.frequency}／使いどころ: ${emoji.usage}）
顔文字の使用: ${
    kaomoji.usesKaomoji
      ? `使う（記号: ${kaomoji.preferred.join("、") || "特になし"}／頻度目安: ${kaomoji.frequency}／使いどころ: ${kaomoji.usage}）`
      : "使わない"
  }
装飾記号（♪★☆♡等、絵文字・顔文字以外）の使用: ${
    decorative.usesSymbols
      ? `使う（記号: ${decorative.preferred.join("、") || "特になし"}／使いどころ: ${decorativeUsage}／頻度目安: ${decorative.frequency}）`
      : "使わない"
  }
文末・句読点のクセ: ${
    punctuation.commonSentenceEndings.length
      ? `${punctuation.commonSentenceEndings.join("、")}（${punctuation.tendency}）`
      : "特になし"
  }`;
}

function buildReferencePostsBlock(posts: Pick<SalonReferencePost, "body">[]): string {
  return posts
    .map((p, i) => {
      const trimmed = p.body.trim();
      const excerpted =
        trimmed.length > REFERENCE_POST_EXCERPT_MAX_CHARS
          ? `${trimmed.slice(0, REFERENCE_POST_EXCERPT_MAX_CHARS)}…`
          : trimmed;
      return `--- 参考記事${i + 1} ---\n${excerpted}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Stage1: 下書き生成
// ---------------------------------------------------------------------------

export function buildStage1SystemPrompt(): string {
  return `あなたは、あるサロンのスタッフが日常的に更新しているブログの下書きを手伝う「編集アシスタント」です。
プロのコピーライターとして完璧な記事に仕上げることが目的ではありません。
そのサロンで働くスタッフが、営業の合間に自分の言葉で書いたような、少し力の抜けた自然な文章を作ることが目的です。

【最重要ルール：AIっぽさを消す】
・文章を綺麗に整えすぎない。多少の言い回しの粗さは残してよい。
・広告のキャッチコピーのような文章にしない。
・毎回同じような構成・書き出し・締め方にしない（今回指定する構成・書き出し・締め方の指定には必ず従うこと）。
・接続詞（「そして」「また」「そのため」など）を連続して使いすぎない。
・敬語は丁寧すぎる/硬すぎる表現（「〜でございます」「〜いたします」の多用など）を避け、実際にスタッフが書くような、丁寧だが肩の力が抜けた話し言葉に近いトーンにする。
・同じ語尾・同じ言い回しを記事内で繰り返さない。
・サロンやメニューを過剰に宣伝しない。「おすすめです」「ぜひ」を連呼しない。
・来店予約を促す文章は入れても入れなくてもよい。入れる場合も1回・さりげなく。無理に付け足さない。
・専門用語を使う場合は必要最小限にし、噛み砕いた言葉で説明する。
・1文を長くしすぎない。スマートフォンで読まれる前提で、1〜2文ごとに改行し、その改行のたびに空行（1行分の空白行）を入れて段落を分ける。3行以上にわたって文字がぎっしり詰まった見た目にしない。Q&A形式など質問と回答が続く構成でも、質問文と回答文の間・回答文中の1〜2文ごとにも同様に空行を入れる。
  イメージ例（実際の内容ではなく、改行・空行の入れ方の見本）:
  「最近、肌寒い日が増えてきましたね。

  そんな時期になると、乾燥が気になるというお声をよくいただきます。

  今日はそんな時におすすめのケアを少しご紹介します。」
  このように、1〜2文ごとに必ず空行を挟んで文章全体を縦に間延びさせる。
・「このサロンの過去記事に見られる構成の傾向」が示されている場合、見出しや箇条書きは、そのサロンが実際によく使う場面（例: 注意事項、ポイント整理）と今回書く内容が一致するときだけ、そのサロンが使っている記号でそのまま使ってよい。一致しない場合や、そのような傾向が示されていない場合は使わず、通常の文章で書く。使う場合も毎回ではなく、内容に応じて判断する。
・「このサロンの過去記事に見られる絵文字・顔文字・装飾記号の傾向」が示されている場合、そこに記録されている絵文字・顔文字・装飾記号（例: ♪★☆♡や(^O^)(^^)など）だけを、記録されている頻度目安（1記事あたりどの程度か）に近づけて使ってよい。絵文字・顔文字・装飾記号・文末のクセはそれぞれ別カテゴリなので混同しない（顔文字を絵文字の代わりに使う、装飾記号を顔文字と誤用する、などをしない）。そこに記録が無い絵文字・顔文字・記号を新しく作らない。傾向が示されていない場合や「使わない」となっている場合は、通常のトーンで書き、無理に絵文字・記号・顔文字を増やさない。使う場合も文章の内容（例えば注意事項や事実の説明）に合わない箇所には使わない。

【絶対に守るルール：事実関係】
・サロン設定に書かれていない事実（存在しないメニュー、成分、効果など）を絶対に作らない。
・医療的な効果・効能を断定しない（「治る」「改善する」「効果がある」と断言しない）。
・美容効果を誇張しない（「劇的に」「必ず」「誰でも」などの誇張表現を使わない）。

【避けたい定型文（禁止ではないが、毎回同じものを使わない）】
以下は、AIが書いた記事によく出てくる典型的な言い回しです。使用禁止ではありませんが、連発せず、記事ごとに違う書き出し・締め方にしてください。
${buildBannedPhrasesList()}

【出力形式】
・title：記事タイトル。20〜40字程度を目安に、内容が一目でわかる自然な見出しにする。「〜について」で終わる機械的なタイトルばかりにしない。
・body：記事本文。指定された文字数はあくまで目安。文字数を合わせるための不自然な水増しや、同じ内容の繰り返しはしない。
  Markdown記法（太字を表す記号、見出しの#、-や・の箇条書き、コードを囲む記号など）は一切使わない。装飾のない、そのままブログに貼り付けられるプレーンテキストで書く。強調したい部分も記号ではなく言葉選びで伝える。
・meta：実際に採用した構成・書き出し・締め方・テーマカテゴリを、指定された選択肢の中からそれぞれ1つ選んで返す。`;
}

export interface Stage1PromptParams {
  salon: BlogGenerationContext;
  season: Season;
  theme: ThemeInput;
  length: ResolvedLength;
  pattern: PatternSelection;
  recentPosts: RecentPostSummary[];
  /** このサロンの文体プロファイル。未生成のサロンでは null（後方互換）。 */
  styleProfile: SalonStyleProfileData | null;
}

export function buildStage1UserPrompt(params: Stage1PromptParams): string {
  const structure = getStructureType(params.pattern.structureType);
  const opening = getOpeningStyle(params.pattern.openingStyle);
  const ending = getEndingStyle(params.pattern.endingStyle);
  const themeCategory = getThemeCategory(params.pattern.themeCategory);

  const themeBlock =
    params.theme.mode === "omakase"
      ? `テーマ指定なし。テーマカテゴリ「${themeCategory.label}」の中から、このサロンの情報に合った具体的な話題を自分で考えて書いてください。`
      : `次のテーマについて書いてください: 「${params.theme.text}」`;

  const styleStructureSection = params.styleProfile
    ? `\n\n【このサロンの過去記事に見られる構成の傾向（参考情報。内容が合致するときだけ使う）】\n${buildStyleStructureBlock(params.styleProfile)}`
    : "";
  const styleExpressionSection = params.styleProfile
    ? `\n\n【このサロンの過去記事に見られる絵文字・顔文字・装飾記号の傾向（参考情報。頻度・場面を参考にする）】\n${buildStyleExpressionBlock(params.styleProfile)}`
    : "";

  return `【サロン情報】
${buildSalonInfoBlock(params.salon)}

【季節】
現在の季節: ${params.season.label}（${params.season.month}月、日本時間）
※季節の話題は自然に触れる程度でよい。無理に絡めなくてもよい。

【テーマ】
${themeBlock}

【今回の構成・書き出し・締め方の指定（運営側が直近の記事と被らないように選んだものです。必ず反映してください）】
構成パターン: ${structure.label} — ${structure.description}
書き出しのタイプ: ${opening.label}
締め方のタイプ: ${ending.label}
テーマカテゴリ: ${themeCategory.label}

【文字数の目安】
目安: ${params.length.target}字前後（許容範囲: 約${params.length.min}〜${params.length.max}字）。目安であり、厳密な一致は不要。自然さを優先する。

【直近の記事（重複回避のための参考情報。内容や言い回しを真似しない）】
${buildRecentPostsBlock(params.recentPosts)}
※上記と似た切り口・言い回し・書き出し・締め方にならないようにしてください。${styleStructureSection}${styleExpressionSection}`;
}

export const STAGE1_SCHEMA: JsonSchemaSpec = {
  name: "blog_draft",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      meta: {
        type: "object",
        additionalProperties: false,
        properties: {
          structureType: { type: "string", enum: STRUCTURE_TYPE_IDS },
          openingStyle: { type: "string", enum: OPENING_STYLE_IDS },
          endingStyle: { type: "string", enum: ENDING_STYLE_IDS },
          themeCategory: { type: "string", enum: THEME_CATEGORY_IDS },
        },
        required: ["structureType", "openingStyle", "endingStyle", "themeCategory"],
      },
    },
    required: ["title", "body", "meta"],
  },
};

// ---------------------------------------------------------------------------
// Stage2: 自然さチェック
// ---------------------------------------------------------------------------

export function buildStage2SystemPrompt(): string {
  return `あなたはブログ記事の「AIっぽさ」をチェックし、必要な場合のみ自然に書き直す校正担当です。
問題がなければ書き直さず、そのまま返してください。

【チェック項目】
1. 下記の定型文リストを使っていないか（多用していないか）
2. 直近の記事と書き出し・締め方・切り口が似すぎていないか
3. 広告っぽい/整いすぎた/丁寧すぎるAIっぽい文章になっていないか
4. 事実の誇張・断定的な効果表現がないか（医療効果の断定、誇張表現）
5. 文体がこのサロンの「文体プロファイル」「参考記事」に近いか
   （文体プロファイル・参考記事が示されていない場合、この項目は無視してよい）
6. Markdown記法（**太字**、# 見出し、- や・の箇条書きなど）が使われていないか。装飾のないプレーンテキストになっているか
7. 1〜2文ごとに改行し、その改行のたびに空行（1行分の空白行）が入っているか。3行以上文字が詰まった塊が残っていないか（スマートフォンで読む前提）
8. 下書きの中に見出し・箇条書きが使われている場合、そのサロンが実際に使っている記号・場面（文体プロファイルの構成の傾向）に沿っているか
   （文体プロファイルが示されていない場合、この項目は無視してよい）
9. 下書きの中に絵文字・顔文字・装飾記号が使われている場合、そのサロンの傾向（文体プロファイルの絵文字・顔文字・装飾記号の傾向）にある記号のみを使っているか、頻度が明らかに過剰になっていないか
   （文体プロファイルが示されていない場合、この項目は無視してよい）

【定型文リスト】
${buildBannedPhrasesList()}

【参考記事についての絶対ルール（文体プロファイル・参考記事が示されている場合のみ適用）】
・以下に「参考記事」が示されている場合、それはこのサロンのスタッフが実際に書いた記事です。
・参考にしてよいのは口調・語尾・テンポ・一文の長さ・改行の入れ方・絵文字の使用量・よく使う言い回しのみ。
・参考記事に書かれている具体的なエピソード・出来事・固有名詞・体験談は絶対に使い回さない（内容の流用は厳禁）。
・下書き（今回生成する記事）の話題・内容は変えない。文体だけを整える。

【対応方法】
・問題がなければ revised=false とし、title/bodyは入力のまま返す。
・軽微な問題（定型文が1箇所ある等）は、その部分だけ自然に言い換えて revised=true。
・Markdown記法が見つかった場合は必ず除去する。改行・空行が少ない塊があれば、1〜2文ごとに改行し、その改行のたびに空行を入れて段落を分け、revised=true とする。
・見出し・箇条書きの記号が文体プロファイルと異なる、または内容に合わない箇所に無理に使われている場合は、プロファイルの記号に直すか、通常の文章に戻す。ただし、新たに見出し・箇条書きを作るかどうかの判断は下書きの時点（Stage1）で既に行われているため、ここでは見出し・箇条書きを新規に作り出さない。あくまで既にある場合の記号・使いどころの整合性チェックのみ行う。
・絵文字・顔文字・装飾記号についても同様に、プロファイルに無い記号が使われている、頻度が明らかに過剰、またはカテゴリの混同（顔文字を絵文字扱いする等）があれば、プロファイルの記号・頻度に合わせて調整するか取り除く。新たに絵文字・顔文字・装飾記号を追加する判断はStage1側で行うため、ここでは新規追加は行わない。
・大きな問題があれば文章全体のトーンを調整する。ただし指定されている構成・書き出し・締め方の「種類」自体は変えない（表現だけを直す）。
・文字数の目安から大きく外れないようにする。

【出力】
revised（boolean）、title、body、issuesFound（見つけた問題の短いタグの配列。何もなければ空配列）`;
}

export interface Stage2PromptParams {
  draft: Pick<Stage1Draft, "title" | "body">;
  length: ResolvedLength;
  /** 直近の自社記事（AI生成）。重複回避専用で、文体参考には使わない。 */
  recentPosts: RecentPostSummary[];
  /** このサロンの文体プロファイル。未生成のサロンでは null（後方互換）。 */
  styleProfile: SalonStyleProfileData | null;
  /** 文体参考用の参考記事（スタッフ本人執筆）。空配列なら該当セクションを出力しない。 */
  referencePosts: Pick<SalonReferencePost, "body">[];
}

export function buildStage2UserPrompt(params: Stage2PromptParams): string {
  const styleSection = params.styleProfile
    ? `\n\n【このサロンの文体プロファイル】\n${buildSalonStyleProfileBlock(params.styleProfile)}`
    : "";
  const referenceSection =
    params.referencePosts.length > 0
      ? `\n\n【参考記事（このサロンのスタッフが書いた記事。内容は流用せず、口調・テンポ・改行・絵文字のみ参考にする）】\n${buildReferencePostsBlock(params.referencePosts)}`
      : "";

  return `【下書き】
title: ${params.draft.title}
body: ${params.draft.body}

【文字数の目安】
${params.length.target}字前後（約${params.length.min}〜${params.length.max}字）

【直近の自社記事（AI生成・重複回避用。書き出し・締めの重複チェックにのみ使う）】
${buildRecentPostsBlock(params.recentPosts)}${styleSection}${referenceSection}`;
}

export const STAGE2_SCHEMA: JsonSchemaSpec = {
  name: "blog_qa_result",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      revised: { type: "boolean" },
      title: { type: "string" },
      body: { type: "string" },
      issuesFound: { type: "array", items: { type: "string" } },
    },
    required: ["revised", "title", "body", "issuesFound"],
  },
};

// ---------------------------------------------------------------------------
// 軽微調整: shorten / soften / detail
// ---------------------------------------------------------------------------

export type LightEditMode = "shorten" | "soften" | "detail";

function lightEditInstruction(mode: LightEditMode, newTarget: number): string {
  switch (mode) {
    case "shorten":
      return `文章量を全体で目安${newTarget}字程度まで短くしてください。要点を絞り、説明の重複や冗長な言い回しを削ってください。不自然な省略や体言止めの多用はしないでください。`;
    case "soften":
      return "文章のトーンをもう少しやわらかく、親しみやすい言い方に調整してください。硬い言い回しや丁寧すぎる敬語を、話し言葉に近い自然な表現に変えてください。文字数は大きく変えなくてよいです。";
    case "detail":
      return `文章量を全体で目安${newTarget}字程度まで増やし、具体的な説明やちょっとした一言を加えて内容を厚くしてください。サロン情報にない具体的な成分名・効果・数値などは作らないこと。単なる水増しはしないでください。`;
  }
}

export function buildLightEditSystemPrompt(mode: LightEditMode, newTarget: number): string {
  return `あなたはサロンブログの下書きを、指示に沿って軽く調整するアシスタントです。
全体を書き直すのではなく、指示された部分だけを直してください。
文章の自然さ・AIっぽくならないことを最優先してください（丁寧すぎる/広告っぽい表現、定型文の多用は避ける）。
サロン設定に書かれていない事実は追加しないでください。
Markdown記法（**太字**、# 見出し、- や・の箇条書きなど）は使わず、装飾のないプレーンテキストのまま出力してください。1〜2文ごとに改行し、その改行のたびに空行（1行分の空白行）を入れて段落を分け、長い文の塊にならないようにしてください。

今回の調整内容: ${lightEditInstruction(mode, newTarget)}

出力は title と body のみ。`;
}

export interface LightEditPromptParams {
  salon: BlogGenerationContext;
  currentTitle: string;
  currentBody: string;
}

export function buildLightEditUserPrompt(params: LightEditPromptParams): string {
  return `【サロン情報】
${buildSalonInfoBlock(params.salon)}

【現在の下書き】
title: ${params.currentTitle}
body: ${params.currentBody}`;
}

export const LIGHT_EDIT_SCHEMA: JsonSchemaSpec = {
  name: "blog_light_edit",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["title", "body"],
  },
};

/** shorten/detail用の新しい目標文字数を現在の本文長から算出する。 */
export function computeAdjustedTarget(mode: LightEditMode, currentBodyLength: number): number {
  if (mode === "shorten") {
    return Math.min(
      Math.max(Math.round(currentBodyLength * 0.7), CUSTOM_LENGTH_BOUNDS.min),
      CUSTOM_LENGTH_BOUNDS.max
    );
  }
  if (mode === "detail") {
    return Math.min(
      Math.max(Math.round(currentBodyLength * 1.3), CUSTOM_LENGTH_BOUNDS.min),
      CUSTOM_LENGTH_BOUNDS.max
    );
  }
  return currentBodyLength;
}

// ---------------------------------------------------------------------------
// Style Profile生成: 参考記事から文体だけを分析する、Stage1/2とは独立したAI呼び出し。
// ブログ生成のたびには実行せず、設定画面のボタン押下時のみ呼ばれる。
// ---------------------------------------------------------------------------

export function buildStyleProfileSystemPrompt(): string {
  return `あなたは、サロンのスタッフが過去に書いたブログ記事を読み、その「文体」と「構成・見せ方」を分析する専門アシスタントです。
記事の内容（話題・エピソード・メニュー名・固有名詞等）は分析対象に含めず、書き方の特徴だけを抽出してください。

【分析から除外すべき内容】
記事の本文には、以下のような「著者の自然な文体」ではない定型的な部分が含まれていることがあります。これらは分析対象に含めないでください。
・住所、電話番号、営業時間などの店舗情報
・SNS風のハッシュタグの羅列（例:「#毛穴ケア #美肌」のような一覧）
・複数の記事で一字一句同じ内容が繰り返される署名・宣伝ブロック（店名や「〜を根本改善」のような固定のキャッチコピーなど）
これらをcommonExpressions等に含めると、スタッフ本人の口癖ではなく毎回貼り付けられた定型文を「よく使う表現」として誤って学習してしまいます。

【見出し記号についての重要な注意】
headingStyleのpreferredSymbolsには、"#"（シャープ）を絶対に含めないでください。"#"はMarkdown記法の見出し記号であり、この分析結果は「Markdownを一切使わない」という別のルールと合わせて使われるため、"#"を報告すると矛盾が生じます。記事中に"#"が見つかった場合も、それは見出しではなくSNS風のハッシュタグである可能性が高いため無視してください。見出し記号として報告してよいのは【】〈〉■◆などの視覚的な記号のみです。

【文章表現について】
・tone: 文章全体のトーン（例:「親しみやすく柔らかい」「落ち着いた上品な語り口」など）
・sentenceLength: 一文の長さの傾向（例:「短め」「やや長め」）
・politeness: 敬語のレベル（例:「丁寧だが堅すぎない」「かなりフォーマル」）
・emojiLevel: 絵文字の使用量・使い方の傾向（使っていなければ「使わない」等）
・lineBreakStyle: 改行の入れ方の傾向（例:「2〜3文ごとに改行」「段落ごとにまとめて改行」）
・endingStyle: 記事の締め方・CTAの強さの傾向
・commonExpressions: 複数の記事で繰り返し使われている、特徴的な言い回しや語尾（配列、最大10個程度。無ければ空配列）
・avoidExpressions: これらの記事では使われておらず、この文体には合わないと思われる表現（配列、任意。無ければ空配列）

【構成・レイアウトについて】
・headingStyle: 〈見出し〉【見出し】■見出しのような小見出し記号を記事内で使っているか（usesHeadings）。使っているなら実際に使われている記号（preferredSymbols、複数あれば全て）と、どんな場面で使う傾向があるか（usage、例:「注意事項やポイント整理の直前」）。使っていなければ usesHeadings=false、preferredSymbols=[]、usage="特になし" とする。
・listStyle: ・や✓、①②③のような箇条書き記号（usesBulletLists / preferredBullets）や、番号付きの手順リスト（usesNumberedLists）を使っているか。使っているなら、どんな内容で使う傾向があるか（commonUseCases。例:「注意事項」「おすすめポイント」「施術前後の説明」「対象となる悩み」「ホームケア」「メニュー説明」など、実際の記事から読み取れるものを最大5個程度）。使っていなければ usesBulletLists=false、usesNumberedLists=false、preferredBullets=[]、commonUseCases=[] とする。
・compositionPattern: 見出し→本文→箇条書き、のような記事全体の構成パターンの傾向を自由記述で（例:「まず見出しで話題を提示し、本文で軽く説明したあと箇条書きでまとめることが多い」）。特に決まったパターンが見られなければ "特になし" とする。

【絵文字・顔文字・装飾記号・句読点のクセについて（重要: 4つを混同しない）】
記事本文には、性質の異なる4種類の装飾が混在していることがあります。カテゴリの境界を厳密に守り、同じ記号を2つ以上のカテゴリに重複して分類しないでください。
・emojiStyle（本物のUnicode絵文字のみ）: 😊✨🌿☺️🙏💡のような、いわゆる絵文字ピッカーから選ぶ本物のUnicode絵文字だけを対象にする。★☆♪♡◎※→のような日本語の文章で伝統的に使われてきた記号や、"^ ^"「(^^)」のような顔文字（の一部）は、たとえ気持ちを表す記号であってもemojiStyleには絶対に含めない。level（使用量の傾向。使っていなければ"使わない"）、preferred（実際に使われている本物の絵文字。最大10個程度。無ければ空配列）、frequency（例:「1記事に0〜2個程度」。無ければ"特になし"）、usage（どんな場面・文脈で使うか。無ければ"特になし"）。
・kaomojiStyle: (^O^)(^^)(*^^*)(´∀｀)のような、括弧で顔の表情を表す顔文字。"^ ^"のような括弧無しの断片も顔文字の一部とみなしkaomojiStyleに分類する（emojiStyleには入れない）。usesKaomoji、preferred（実際に使われている顔文字そのまま。最大10個程度）、frequency、usage。使っていなければ usesKaomoji=false、preferred=[]、frequency="特になし"、usage="特になし"。
・decorativeSymbolStyle（絵文字でも顔文字でもない記号装飾）: ♪★☆♡◎※→！のような記号。これらは上記のemojiStyleには絶対に含めない（★☆♪♡はdecorativeSymbolStyleにのみ分類する）。usesSymbols、preferred（実際に使われている記号。最大10個程度）、usageNotes（記号ごとの使いどころを配列で。例: [{symbol: "♪", usage: "やわらかい案内や文末"}, {symbol: "★", usage: "おすすめ・強調"}]）、frequency（1記事あたりの目安）。使っていなければ usesSymbols=false、preferred=[]、usageNotes=[]、frequency="特になし"。
・punctuationStyle: 文末・句読点のクセ（感嘆符の多用、波ダッシュ「〜」、句点を重ねる「。。」など、絵文字・顔文字・装飾記号そのものではなく句読点レベルの癖）。commonSentenceEndings（実際に見られる文末表現。最大10個程度）、tendency（自由記述の傾向）。特に無ければ commonSentenceEndings=[]、tendency="特になし"。

frequency・usageを書く際は、単に記号を列挙するだけでなく、可能な範囲で「文末で使うことが多いか」「見出しで使うか」「明るい話題のときによく使われるか」「注意事項のような文章では使われていないか」「1記事あたり大体何個程度か」といった具体的な使われ方も盛り込んでください。emojiStyle・kaomojiStyle・decorativeSymbolStyleのpreferred/preferredSymbols/preferredBulletsには、Markdown記法の記号（#、##、**、*、-、_、\`など）を絶対に含めないでください。

【絵文字・顔文字・装飾記号は、口癖と違って毎回全記事に出てくるとは限らない】
tone・commonExpressions等の文体の特徴は「複数の記事に共通しているか」を重視してよいですが、絵文字・顔文字・装飾記号・文末のクセ（emojiStyle/kaomojiStyle/decorativeSymbolStyle/punctuationStyle）は、口癖ほど毎回現れるとは限らず、使われるとしても一部の記事に散発的に出てくるのが自然です。分析対象の記事のうち1件にしか出てこない記号であっても、実際に本文中で使われていれば preferred 等に含めてください（複数記事での頻出を条件にしない）。ただし、明らかに1文字だけの誤変換・記号化けのようなノイズは除外してください。
また、★と☆のように見た目が似ている記号でも、本文中で実際に使われている文字はすべて別々の記号として扱ってください（似ているからと言って一方だけを代表として選び、もう一方を省略しない）。

見出しや箇条書き（headingStyle/listStyle）は、実際に複数の記事で使われている場合のみ「使う」と判定し、1記事にしか出てこない場合や不明瞭な場合は無理に「使う」と判定しないでください（こちらは上記の絵文字・顔文字・装飾記号とは異なる基準です）。`;
}

export interface StyleProfilePromptParams {
  posts: Pick<SalonReferencePost, "title" | "body">[];
}

export function buildStyleProfileUserPrompt(params: StyleProfilePromptParams): string {
  const articles = params.posts
    .map((p, i) => {
      const trimmed = p.body.trim();
      const body =
        trimmed.length > STYLE_PROFILE_SOURCE_BODY_TRUNCATE
          ? `${trimmed.slice(0, STYLE_PROFILE_SOURCE_BODY_TRUNCATE)}…`
          : trimmed;
      return `--- 記事${i + 1} ---\nタイトル: ${p.title}\n本文:\n${body}`;
    })
    .join("\n\n");

  return `以下は、このサロンのスタッフが実際に書いたブログ記事です（${params.posts.length}件）。これらの文体を分析してください。

${articles}`;
}

export const STYLE_PROFILE_SCHEMA: JsonSchemaSpec = {
  name: "salon_style_profile",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tone: { type: "string" },
      sentenceLength: { type: "string" },
      politeness: { type: "string" },
      emojiLevel: { type: "string" },
      lineBreakStyle: { type: "string" },
      endingStyle: { type: "string" },
      commonExpressions: { type: "array", items: { type: "string" } },
      avoidExpressions: { type: "array", items: { type: "string" } },
      headingStyle: {
        type: "object",
        additionalProperties: false,
        properties: {
          usesHeadings: { type: "boolean" },
          preferredSymbols: { type: "array", items: { type: "string" } },
          usage: { type: "string" },
        },
        required: ["usesHeadings", "preferredSymbols", "usage"],
      },
      listStyle: {
        type: "object",
        additionalProperties: false,
        properties: {
          usesBulletLists: { type: "boolean" },
          usesNumberedLists: { type: "boolean" },
          preferredBullets: { type: "array", items: { type: "string" } },
          commonUseCases: { type: "array", items: { type: "string" } },
        },
        required: ["usesBulletLists", "usesNumberedLists", "preferredBullets", "commonUseCases"],
      },
      compositionPattern: { type: "string" },
      emojiStyle: {
        type: "object",
        additionalProperties: false,
        properties: {
          level: { type: "string" },
          preferred: { type: "array", items: { type: "string" } },
          frequency: { type: "string" },
          usage: { type: "string" },
        },
        required: ["level", "preferred", "frequency", "usage"],
      },
      kaomojiStyle: {
        type: "object",
        additionalProperties: false,
        properties: {
          usesKaomoji: { type: "boolean" },
          preferred: { type: "array", items: { type: "string" } },
          frequency: { type: "string" },
          usage: { type: "string" },
        },
        required: ["usesKaomoji", "preferred", "frequency", "usage"],
      },
      decorativeSymbolStyle: {
        type: "object",
        additionalProperties: false,
        properties: {
          usesSymbols: { type: "boolean" },
          preferred: { type: "array", items: { type: "string" } },
          usageNotes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                symbol: { type: "string" },
                usage: { type: "string" },
              },
              required: ["symbol", "usage"],
            },
          },
          frequency: { type: "string" },
        },
        required: ["usesSymbols", "preferred", "usageNotes", "frequency"],
      },
      punctuationStyle: {
        type: "object",
        additionalProperties: false,
        properties: {
          commonSentenceEndings: { type: "array", items: { type: "string" } },
          tendency: { type: "string" },
        },
        required: ["commonSentenceEndings", "tendency"],
      },
    },
    required: [
      "tone",
      "sentenceLength",
      "politeness",
      "emojiLevel",
      "lineBreakStyle",
      "endingStyle",
      "commonExpressions",
      "avoidExpressions",
      "headingStyle",
      "listStyle",
      "compositionPattern",
      "emojiStyle",
      "kaomojiStyle",
      "decorativeSymbolStyle",
      "punctuationStyle",
    ],
  },
};
