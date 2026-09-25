// サロンに依存しない、ブログ生成の共通ルールブック。
// ここに書いた内容は「どのサロンでも通用する一般的なルール」だけにし、
// 特定業種・特定施術に固有の分岐は書かない（それは config/salon.ts 側のデータとして
// AIに渡し、AI自身に判断させる）。
// (blog-appの config/blogRules.ts を無変更で移植)

export const STRUCTURE_TYPES = [
  {
    id: "worry_reason_solution",
    label: "悩み→理由→対策",
    description: "読者が抱えていそうな悩みを挙げ、その理由を説明し、対策やケア方法につなげる構成。",
  },
  {
    id: "qa",
    label: "Q&A形式",
    description: "よくある質問とその回答を1〜3セット並べる構成。",
  },
  {
    id: "season_topic_care",
    label: "季節の話→肌への影響→おすすめケア",
    description: "季節の話題から入り、肌や髪への影響に触れ、おすすめのケアを紹介する構成。",
  },
  {
    id: "treatment_intro_fit_caution",
    label: "施術紹介→向いている人→注意点",
    description: "メニュー・施術を紹介し、どんな人に向いているか、注意点は何かを伝える構成。",
  },
  {
    id: "home_care_focus",
    label: "ホームケア中心",
    description: "来店を促す内容ではなく、自宅でできるケア方法を中心に伝える構成。",
  },
  {
    id: "recent_consultation_focus",
    label: "最近よく聞く相談",
    description: "最近スタッフがよく受ける相談・質問を紹介し、それについて答える構成。",
  },
  {
    id: "trivia",
    label: "豆知識",
    description: "美容・施術に関する豆知識やちょっとした情報を紹介する構成。",
  },
] as const;
export type StructureTypeId = (typeof STRUCTURE_TYPES)[number]["id"];
export const STRUCTURE_TYPE_IDS = STRUCTURE_TYPES.map((s) => s.id) as StructureTypeId[];

export const OPENING_STYLES = [
  { id: "season_greeting", label: "季節や気候の話題から入る" },
  { id: "direct_topic", label: "前置きなしにテーマを切り出す" },
  { id: "question_to_reader", label: "読者への問いかけから入る" },
  { id: "recent_episode", label: "最近あった出来事やお客様とのやり取りから入る" },
  { id: "trivia_hook", label: "ちょっとした豆知識・小ネタから入る" },
  { id: "casual_greeting", label: "軽い挨拶や近況から入る" },
] as const;
export type OpeningStyleId = (typeof OPENING_STYLES)[number]["id"];
export const OPENING_STYLE_IDS = OPENING_STYLES.map((s) => s.id) as OpeningStyleId[];

export const ENDING_STYLES = [
  { id: "one_line_takeaway", label: "一言まとめ" },
  { id: "self_care_tip", label: "セルフケアのひとことアドバイス" },
  { id: "question_to_reader", label: "読者への軽い問いかけ" },
  { id: "next_time_teaser", label: "次回予告的な一言" },
  { id: "trivia", label: "豆知識・おまけ情報" },
  { id: "seasonal_remark", label: "季節に関する一言" },
  { id: "no_cta_stop", label: "特にまとめず自然に終える（CTAなし）" },
  { id: "salon_trait_mention", label: "サロンの雰囲気や特徴に軽く触れる" },
] as const;
export type EndingStyleId = (typeof ENDING_STYLES)[number]["id"];
export const ENDING_STYLE_IDS = ENDING_STYLES.map((s) => s.id) as EndingStyleId[];

export const THEME_CATEGORIES = [
  { id: "seasonal_care", label: "季節ケア" },
  { id: "home_care", label: "ホームケア" },
  { id: "treatment_info", label: "施術について" },
  { id: "faq", label: "よくあるご質問" },
  { id: "trivia", label: "豆知識" },
  { id: "recent_consultations", label: "最近のご相談" },
] as const;
export type ThemeCategoryId = (typeof THEME_CATEGORIES)[number]["id"];
export const THEME_CATEGORY_IDS = THEME_CATEGORIES.map((c) => c.id) as ThemeCategoryId[];

// 使用禁止ではなく「多用回避」リスト。AIへのプロンプトで明示し、連発させない。
export const SOFT_BANNED_PHRASES = [
  "いかがでしたでしょうか？",
  "ぜひ一度お試しください",
  "お気軽にご相談ください",
  "皆様のご来店を心よりお待ちしております",
  "少しでも参考になれば嬉しいです",
  "ぜひ参考にしてみてください",
  "美しい肌を手に入れましょう",
  "一緒に理想のお肌を目指しましょう",
] as const;

export type LengthType = "short" | "standard" | "long" | "custom";

export const LENGTH_PRESETS: Record<
  Exclude<LengthType, "custom">,
  { label: string; min: number; max: number; target: number }
> = {
  short: { label: "短め", min: 300, max: 500, target: 400 },
  standard: { label: "標準", min: 500, max: 800, target: 650 },
  long: { label: "しっかり", min: 800, max: 1200, target: 1000 },
};

export const CUSTOM_LENGTH_BOUNDS = { min: 200, max: 2000 } as const;

// バラエティ選定・履歴参照のチューニング値。
export const HISTORY_LOOKBACK_FOR_VARIETY = 8; // パターン除外判定に使う件数
export const HISTORY_EXCERPTS_FOR_PROMPT = 5; // うちプロンプトに渡す件数
export const RECENT_EXCLUDE_COUNT = 2; // 直近何件分の値を除外対象にするか

// タイムアウト値はVercel Hobbyプラン(Function実行時間の上限)に合わせて、
// blog-app本来の値(30s/20s/20s、合計最悪70s)から余裕を持って短縮している。
// 実際の上限は実装時にVercelダッシュボードで再確認すること(review-app側の
// 既存API `app/api/generate-review/route.ts` は単発30sタイムアウトで運用中)。
export const GENERATION_PARAMS = {
  stage1: { temperature: 1.05, maxTokens: 2200, timeoutMs: 25_000 },
  stage2: { temperature: 0.5, maxTokens: 2200, timeoutMs: 15_000 },
  lightEdit: { temperature: 0.7, maxTokens: 1800, timeoutMs: 15_000 },
} as const;

export const GENERIC_GENERATION_ERROR =
  "ブログを作成できませんでした。少し時間をおいて、もう一度お試しください。";

export const INVALID_REQUEST_ERROR = "リクエストが正しくありません。";

export const GENERATION_LOCKED_ERROR =
  "現在ほかのブログを生成中です。少し時間をおいてからもう一度お試しください。";

export function getStructureType(id: StructureTypeId) {
  return STRUCTURE_TYPES.find((s) => s.id === id) ?? STRUCTURE_TYPES[0];
}
export function getOpeningStyle(id: OpeningStyleId) {
  return OPENING_STYLES.find((s) => s.id === id) ?? OPENING_STYLES[0];
}
export function getEndingStyle(id: EndingStyleId) {
  return ENDING_STYLES.find((s) => s.id === id) ?? ENDING_STYLES[0];
}
export function getThemeCategory(id: ThemeCategoryId) {
  return THEME_CATEGORIES.find((c) => c.id === id) ?? THEME_CATEGORIES[0];
}
