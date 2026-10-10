import type { Feature } from "@/lib/appMode";
import type { GoogleFeature } from "@/lib/google/scopes";

// SalonPack の機能と、その機能を使うために必要な設定の対応を1か所で管理する。
// 新しい機能を追加するときは、ここに1件足し、必要なら SETUP_ITEMS に設定項目を足すだけにする
// (画面・Server Action・定期処理は lib/features/featureState.ts の判定を共通で使う)。
// 機能名・説明は既存の画面の表記に合わせる。
//
// ここで扱うのは「お客様が使う機能の選択」と「設定の完了」。契約上の利用権限は salons.plan
// (lib/access/plan.ts)、Google の許可は google_accounts / salon_google_bindings、
// 予約通知の運用状態は reservation_notification_operations が正で、ここでは変えない。

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

export interface FeatureDefinition {
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
  /** 'coming_soon' は選択・接続できない(準備中と表示する)。 */
  availability: "available" | "coming_soon";
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
  },
  {
    key: "google_reviews",
    label: "届いた口コミ",
    description: "Googleに届いた口コミの確認と、返信の準備ができます。",
    accessFeature: "google_reviews",
    href: "/dashboard/settings/google",
    googleFeature: "gbp",
    requiresLine: false,
    setupItems: ["google_gbp", "gbp_location"],
    availability: "coming_soon",
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
    href: "/dashboard/settings/google",
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
