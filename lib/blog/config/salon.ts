// ブログ機能用のサロン設定と、その選択肢一覧。
// 生成ロジック（config/blogRules.ts, lib/blog/prompts.ts）はこのファイルの中身を
// 一切前提にせず、ここで定義した型・値をそのまま読んで動く。
//
// (blog-app由来。DEFAULT_SALON_IDは削除した — SalonPack統合後は、認証済み
// ユーザーからサーバー側で getCurrentSalon() を通じて解決した salon.id を
// 呼び出し元が明示的に渡す。固定値は一切使わない。)
//
// 店舗名・業種はここでは扱わない — SalonPack共通のサロン設定(salons.name /
// salons.business_type、getCurrentSalon()経由)を正として扱い、ブログ生成時に
// サーバー側で合成する(lib/blog/types.ts の BlogGenerationContext、
// app/api/blog/generate/route.ts 参照)。旧blog-appにあった業種enumは廃止した。

export const TONE_OPTIONS = ["親しみやすい", "上品", "カジュアル", "少し専門的"] as const;
export type ToneOption = (typeof TONE_OPTIONS)[number];

export const EMOJI_LEVELS = ["使わない", "少なめ", "普通"] as const;
export type EmojiLevel = (typeof EMOJI_LEVELS)[number];

// ターゲットのクイック選択チップ。タップすると複数選択できるタグとして追加される
// （選択肢に無いターゲット層のサロンにも対応できるよう、自由入力も残す）。
export const TARGET_CUSTOMER_PRESETS = [
  "20代女性",
  "30〜40代女性",
  "30〜50代女性",
  "男女問わず",
  "ファミリー層",
] as const;

export const TAG_LIST_LIMITS = { maxItems: 8, maxItemLength: 20 } as const;

// 入力欄のプレースホルダー例（業種に依らない汎用例。UI文言のみで、生成ロジックには使わない）。
export const FIELD_EXAMPLES = {
  mainMenu: "コース名",
  specialties: "得意なメニュー",
  commonConcerns: "よくある悩み",
} as const;

export const SHORT_TEXT_LIMITS = {
  salonTraits: 200,
  avoidExpressions: 200,
} as const;

export interface SalonSettings {
  /** SalonPackの salons.id (uuid文字列)。呼び出し元が必ず認証済みセッションから解決して渡す。 */
  salonId: string;
  mainMenu: string[];
  specialties: string[];
  targetCustomers: string[];
  commonConcerns: string[];
  salonTraits: string;
  tone: ToneOption;
  emojiLevel: EmojiLevel;
  avoidExpressions: string | null;
  /**
   * 文体参照機能で登録する、このサロンのHot Pepper BeautyブログURL。
   * 一般設定フォーム（SalonSettingsForm）からは編集させず、
   * app/dashboard/blog/settings/style-profile/actions.ts 経由でのみ更新する（単一責任のため）。
   */
  hotpepperBlogUrl: string | null;
}

// salonIdは常に呼び出し元(queries.ts)がspreadの後に実際の値で上書きするため、
// ここでの値はダミーであり参照されない。
export const DEFAULT_SALON_SETTINGS: Omit<SalonSettings, "salonId"> = {
  mainMenu: [],
  specialties: [],
  targetCustomers: [],
  commonConcerns: [],
  salonTraits: "",
  tone: "親しみやすい",
  emojiLevel: "少なめ",
  avoidExpressions: null,
  hotpepperBlogUrl: null,
};
