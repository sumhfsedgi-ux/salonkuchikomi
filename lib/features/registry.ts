import type { Feature } from "@/lib/appMode";
import type { GoogleFeature } from "@/lib/google/scopes";

// SalonPack の機能と、その機能を使うために必要な設定の対応を1か所で管理する。
// 新しい機能を追加するときは、ここに1件足し、必要なら SETUP_ITEMS に設定項目を足すだけにする
// (画面・Server Action・定期処理は lib/features/featureState.ts の判定を共通で使う)。
// 機能名・説明は既存の画面の表記に合わせる。
//
// ここで扱うのは、機能の表示(名前・説明・アイコン・分類・表示順)と「設定の完了」。
// 利用権限(対象プラン・プラン内の標準・提供状態・サロンごとの個別設定)は、entitlement が "catalog" の機能は
// DB の機能カタログ(supabase/migrations/0024 の feature_catalog・plan_feature_rules・salon_feature_overrides)が正で、
// 画面・API・通知処理は同じ DB の関数(salon_feature_access)の結果を使う(lib/features/entitlements.ts)。
// 届いた口コミ(google_reviews)も 0030 から "catalog"。そのうえで GOOGLE_REVIEWS_OAUTH_ENABLED が無効なら準備中のまま
// (lib/features/access.ts)。"code" の機能は今は無い(lib/access/plan.ts と availability で判定する仕組みは残す)。
// Google の許可は google_accounts / salon_google_bindings、予約通知の運用状態は reservation_notification_operations が正で、
// ここでは変えない。
// 機能を足すときは、ここに1件足し、DB の機能カタログには migration で coming_soon として足す(既存店舗に自動で開放しない)。
// 利用許可とメニューの配置は分ける(メニューの配置は components/layout/navItems.ts)。

export type FeatureKey = "reviews" | "blog" | "reservation_notifications" | "google_reviews";

export type SetupItemKey =
  | "review_survey"
  | "review_google_url"
  | "blog_settings"
  | "google_gmail"
  | "line_recipients"
  | "reservation_start"
  | "google_gbp"
  | "gbp_location";

export type FeatureCategory = "customer_voice" | "marketing" | "operations";

export const FEATURE_CATEGORIES: ReadonlyArray<{ key: FeatureCategory; label: string }> = [
  { key: "customer_voice", label: "口コミ" },
  { key: "marketing", label: "集客・発信" },
  { key: "operations", label: "店舗運営" },
];

/** アイコンの種類(画面側で components/ui/icons の部品に対応させる)。 */
export type FeatureIcon = "review" | "blog" | "bell" | "inbox";

export interface FeatureDefinition {
  /** 変えない機能ID(DB の feature_key と同じ)。 */
  key: FeatureKey;
  label: string;
  description: string;
  /** アクセス制御(lib/access/featureAccess.ts)で使う機能ID。契約・APP_MODE の判定はこれで行う。 */
  accessFeature: Feature;
  href: string;
  /** 使うために必要な Google 側の権限(無ければ null)。 */
  googleFeature: GoogleFeature | null;
  /** LINE の送信先が必要か(予約通知だけ。口コミだけのお客様には LINE を必須にしない)。 */
  requiresLine: boolean;
  setupItems: SetupItemKey[];
  /**
   * 'coming_soon' は選択・接続できない(準備中と表示する)。entitlement が "code" の機能だけが使う
   * ("catalog" の機能の提供状態は DB の feature_catalog.lifecycle が正。ここの値は判定に使わない)。
   */
  availability: "available" | "coming_soon";
  /**
   * 画面(ホーム・メニュー・Google連携・サロン設定の案内)に出すか。false の機能は、利用権限の判定・内部の処理は
   * そのままで、画面にだけ出さない(届いた口コミは、受信箱などの中身と一緒に入れるまで出さない)。
   */
  listed: boolean;
  category: FeatureCategory;
  /** 分類の中での表示順(小さいほど先)。 */
  sortOrder: number;
  icon: FeatureIcon;
  /**
   * 利用権限の判定元。"catalog" は DB の機能カタログ・個別設定(運営管理で扱う)、"code" は lib/access/plan.ts と availability。
   */
  entitlement: "catalog" | "code";
}

export const FEATURE_REGISTRY: readonly FeatureDefinition[] = [
  {
    key: "reviews",
    label: "口コミ",
    description: "Google口コミ作成をかんたんに",
    accessFeature: "reviews",
    href: "/dashboard/reviews",
    googleFeature: null,
    requiresLine: false,
    setupItems: ["review_survey", "review_google_url"],
    availability: "available",
    listed: true,
    category: "customer_voice",
    sortOrder: 10,
    icon: "review",
    entitlement: "catalog",
  },
  {
    key: "blog",
    label: "ブログ",
    description: "Hot PepperブログをAIで作成",
    accessFeature: "blog",
    href: "/dashboard/blog",
    googleFeature: null,
    requiresLine: false,
    setupItems: ["blog_settings"],
    availability: "available",
    listed: true,
    category: "marketing",
    sortOrder: 10,
    icon: "blog",
    entitlement: "catalog",
  },
  {
    key: "reservation_notifications",
    label: "予約通知",
    description: "予約をLINEで自動通知",
    accessFeature: "notifications",
    href: "/dashboard/notifications",
    googleFeature: "gmail",
    requiresLine: true,
    setupItems: ["google_gmail", "line_recipients", "reservation_start"],
    availability: "available",
    listed: true,
    category: "operations",
    sortOrder: 10,
    icon: "bell",
    entitlement: "catalog",
  },
  {
    key: "google_reviews",
    label: "届いた口コミ",
    description: "Googleに届いた口コミの確認と、返信の準備ができます。",
    accessFeature: "google_reviews",
    href: "/dashboard/reviews/google",
    googleFeature: "gbp",
    requiresLine: false,
    setupItems: ["google_gbp", "gbp_location"],
    // 提供状態は DB の機能カタログ(0030 で coming_soon・プランの標準は使えない)が正。ここの値は判定に使わない。
    availability: "coming_soon",
    // 単独の入口(ホームのカード・メニュー・設定の案内)は作らない。「口コミ」の中のタブ(届いた口コミ・設定)から使う。
    listed: false,
    category: "customer_voice",
    sortOrder: 20,
    icon: "inbox",
    entitlement: "catalog",
  },
];

export interface SetupItemDefinition {
  key: SetupItemKey;
  label: string;
  description: string;
  href: string;
  /** false は「推奨」(未設定でもその機能は使える)。 */
  required: boolean;
  /** 同じ画面でまとめて設定できる項目のまとまり(チェックリストで1件にまとめる)。 */
  group?: "google" | "line";
}

export const SETUP_ITEMS: Record<SetupItemKey, SetupItemDefinition> = {
  review_survey: {
    key: "review_survey",
    label: "口コミのアンケートを作成",
    description: "お客様が回答する質問と、Google口コミ投稿URLを設定します。",
    href: "/dashboard/setup/reviews",
    required: true,
  },
  review_google_url: {
    key: "review_google_url",
    label: "Google口コミ投稿URLを設定",
    description: "口コミ文の作成後に開くGoogleの投稿ページです。",
    href: "/dashboard/reviews",
    required: false,
  },
  blog_settings: {
    key: "blog_settings",
    label: "ブログ設定を入力",
    description: "主なメニューや文章の雰囲気を入力すると、ブログの内容に反映されます。",
    href: "/dashboard/blog/settings",
    required: false,
  },
  google_gmail: {
    key: "google_gmail",
    label: "Googleと連携(予約メール)",
    description: "Hot Pepperの予約メールが届くGmailと連携します。",
    href: "/dashboard/settings/google",
    required: true,
    group: "google",
  },
  line_recipients: {
    key: "line_recipients",
    label: "LINEの通知先を追加",
    description: "通知を受け取るスタッフ(オーナー本人も可)のLINEを追加します。",
    href: "/dashboard/notifications#recipients",
    required: true,
    group: "line",
  },
  reservation_start: {
    key: "reservation_start",
    label: "予約通知を開始",
    description: "設定がそろったら、予約通知の画面から開始します。",
    href: "/dashboard/notifications",
    required: true,
  },
  google_gbp: {
    key: "google_gbp",
    label: "Googleと連携(届いた口コミ)",
    description: "Googleビジネスプロフィールを管理しているアカウントと連携します。",
    href: "/dashboard/settings/google",
    required: true,
    group: "google",
  },
  gbp_location: {
    key: "gbp_location",
    label: "口コミを受け取る店舗を選択",
    description: "Googleビジネスプロフィールのどの店舗の口コミを扱うかを選びます。",
    href: "/dashboard/reviews/google",
    required: true,
  },
};

export function getFeatureDefinition(key: FeatureKey): FeatureDefinition {
  const def = FEATURE_REGISTRY.find((f) => f.key === key);
  if (!def) throw new Error(`unknown feature: ${key}`);
  return def;
}

export function isFeatureKey(value: unknown): value is FeatureKey {
  return FEATURE_REGISTRY.some((f) => f.key === value);
}
