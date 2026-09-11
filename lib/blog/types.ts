import type {
  StructureTypeId,
  OpeningStyleId,
  EndingStyleId,
  ThemeCategoryId,
  LengthType,
} from "@/lib/blog/config/blogRules";
import type { ToneOption, EmojiLevel } from "@/lib/blog/config/salon";

// (blog-appの lib/types.ts を無変更で移植。salonIdは常にSalonPackのsalons.id。)

/**
 * ブログ生成プロンプトへ渡す、サロン情報の合成結果。
 * name/businessType/description はSalonPack共通のサロン設定(salons テーブル、
 * getCurrentSalon()経由)から取り、それ以外はブログ専用設定(salon_settings
 * テーブル、lib/blog/queries.ts の getSalonSettings())から取る。
 * app/api/blog/generate/route.ts がリクエストのたびにサーバー側で合成する
 * (クライアントからこれらの値を直接受け取ることはない)。
 */
export interface BlogGenerationContext {
  name: string;
  businessType: string | null;
  description: string | null;
  mainMenu: string[];
  specialties: string[];
  targetCustomers: string[];
  commonConcerns: string[];
  salonTraits: string;
  tone: ToneOption;
  emojiLevel: EmojiLevel;
  avoidExpressions: string | null;
}

export interface BlogPost {
  id: string;
  salonId: string;
  title: string;
  body: string;
  /** おまかせ生成時は null。テーマ指定時のみユーザー入力の文言。 */
  theme: string | null;
  lengthType: LengthType;
  lengthTarget: number;
  structureType: StructureTypeId;
  openingStyle: OpeningStyleId;
  endingStyle: EndingStyleId;
  themeCategory: ThemeCategoryId;
  createdAt: string;
  updatedAt: string;
}

/** 一覧表示（履歴）専用の軽量な型。本文は含まない（listPosts()参照）。 */
export interface BlogPostSummary {
  id: string;
  title: string;
  theme: string | null;
  createdAt: string;
}

export type GenerationMode = "create" | "regenerate" | "shorten" | "soften" | "detail";

/** STEP2の「少し調整する」メニューから呼べるモード（createを除く）。 */
export type AdjustMode = Exclude<GenerationMode, "create">;

export type ThemeInput = { mode: "omakase" } | { mode: "specified"; text: string };

export type LengthInput =
  | { type: "short" }
  | { type: "standard" }
  | { type: "long" }
  | { type: "custom"; target: number };

/** Stage1（下書き生成）の構造化出力の形。 */
export interface Stage1Draft {
  title: string;
  body: string;
  meta: {
    structureType: StructureTypeId;
    openingStyle: OpeningStyleId;
    endingStyle: EndingStyleId;
    themeCategory: ThemeCategoryId;
  };
}

/** Stage2（自然さチェック）の構造化出力の形。 */
export interface Stage2Result {
  revised: boolean;
  title: string;
  body: string;
  issuesFound: string[];
}

/** 軽微調整（shorten/soften/detail）の構造化出力の形。 */
export interface LightEditResult {
  title: string;
  body: string;
}

/** プロンプトに渡す、直近記事の要約（本文全文は渡さない）。 */
export interface RecentPostSummary {
  title: string;
  openingExcerpt: string;
  endingExcerpt: string;
  structureType: StructureTypeId;
  openingStyle: OpeningStyleId;
  endingStyle: EndingStyleId;
  themeCategory: ThemeCategoryId;
}

/**
 * 文体参考記事（Hot Pepper Beauty等から取り込んだ、人間が書いた過去記事）。
 * blog_posts（AI生成記事、重複回避用）とは別物。
 */
export interface SalonReferencePost {
  id: string;
  salonId: string;
  source: "hotpepper" | "manual";
  sourceUrl: string;
  title: string;
  body: string;
  authorName: string | null;
  postedAt: string | null;
  useForStyle: boolean;
  importedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Style Profile生成AIが返す、文体を構造化したデータ本体。 */
export interface SalonStyleProfileData {
  tone: string;
  sentenceLength: string;
  politeness: string;
  emojiLevel: string;
  lineBreakStyle: string;
  endingStyle: string;
  commonExpressions: string[];
  avoidExpressions: string[];

  /** 小見出し（〈〉【】■など）の使用傾向。 */
  headingStyle: {
    usesHeadings: boolean;
    /** 例: ["〈 〉"]。使わない場合は空配列。 */
    preferredSymbols: string[];
    /** 例: "注意事項やポイント整理で使用"。使わない場合は "特になし"。 */
    usage: string;
  };
  /** 箇条書き・番号付きリストの使用傾向。 */
  listStyle: {
    usesBulletLists: boolean;
    usesNumberedLists: boolean;
    /** 例: ["・"]。使わない場合は空配列。 */
    preferredBullets: string[];
    /** 例: ["注意事項", "施術前後の説明"]。使わない場合は空配列。 */
    commonUseCases: string[];
  };
  /** 見出し→本文→箇条書き等、記事全体の構成パターンの傾向（自由記述）。使わない場合は "特になし"。 */
  compositionPattern: string;

  /** 一般的なUnicode絵文字（😊✨🌿など）の使用傾向。顔文字・装飾記号とは別カテゴリとして扱う。 */
  emojiStyle: {
    /** 例: "少なめ"。使わない場合は "使わない"。 */
    level: string;
    /** 例: ["✨", "☺️"]。使わない場合は空配列。 */
    preferred: string[];
    /** 例: "1記事に0〜2個程度"。使わない場合は "特になし"。 */
    frequency: string;
    /** 例: "明るい話題の文末で使う"。使わない場合は "特になし"。 */
    usage: string;
  };
  /** 顔文字（(^O^)など）の使用傾向。絵文字とは別カテゴリとして扱う。 */
  kaomojiStyle: {
    usesKaomoji: boolean;
    /** 例: ["(^O^)", "(^^)"]。使わない場合は空配列。 */
    preferred: string[];
    frequency: string;
    usage: string;
  };
  /** ♪★☆♡◎※→など、絵文字・顔文字以外の装飾記号の使用傾向。 */
  decorativeSymbolStyle: {
    usesSymbols: boolean;
    /** 例: ["♪", "★"]。使わない場合は空配列。 */
    preferred: string[];
    /** 記号ごとの使いどころ。例: [{ symbol: "♪", usage: "やわらかい案内や文末" }]。 */
    usageNotes: { symbol: string; usage: string }[];
    frequency: string;
  };
  /** 文末・句読点のクセ（感嘆符の多用、波ダッシュ「〜」、句点を重ねる「。。」など）。 */
  punctuationStyle: {
    /** 例: ["！", "〜", "。。"]。特に無ければ空配列。 */
    commonSentenceEndings: string[];
    /** 自由記述。特に無ければ "特になし"。 */
    tendency: string;
  };
}

export interface SalonStyleProfile {
  salonId: string;
  profile: SalonStyleProfileData;
  sourcePostIds: string[];
  generatedAt: string | null;
  updatedAt: string;
}
