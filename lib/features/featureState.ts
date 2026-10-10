import { isFeatureServedByMode } from "@/lib/appMode";
import { isFeatureEnabledForPlan, type SalonPlan } from "@/lib/access/plan";
import type { GoogleAuthState } from "@/lib/google/db/accounts";
import {
  FEATURE_REGISTRY,
  SETUP_ITEMS,
  type FeatureDefinition,
  type FeatureKey,
  type SetupItemKey,
} from "@/lib/features/registry";

// 機能ごとの状態の判定(DBに触れない純粋な関数。画面・Server Action・定期処理で共通に使う)。
// 次の5つを混同しないように、それぞれ別の入力から判定する:
//   契約上の利用権限(plan × APP_MODE)/ お客様が選んだ機能 / 設定の完了 /
//   外部サービス(Google)の接続と許可 / 実際の稼働状態(予約通知の運用状態)

export type ReservationOpsState = "setup_pending" | "awaiting_cutover" | "active" | "paused";

export interface GoogleConnectionSnapshot {
  bound: boolean;
  authState: GoogleAuthState | null;
  /** その機能の権限が許可されていて、定期処理でも権限不足を検知していない。 */
  scopeGranted: boolean;
  /** 定期処理がその機能だけの権限不足を検知した(アカウント全体の認証は有効のまま)。 */
  scopeMissing?: boolean;
  email: string | null;
  /** 届いた口コミだけ: 対象店舗の選択状態。 */
  selectionState?: "selection_pending" | "selected" | null;
}

export interface SetupContext {
  plan: SalonPlan;
  /** salon_feature_selections の行(保存したことがある機能だけ)。 */
  explicitSelections: Partial<Record<FeatureKey, boolean>>;
  selectionSavedAt: string | null;
  hasActiveSurvey: boolean;
  onboardingCompleted: boolean;
  googleReviewUrl: string | null;
  hasSalonSettingsRow: boolean;
  hasBlogSettings: boolean;
  lineRecipientCount: number;
  hasAnyLineConnection: boolean;
  gmail: GoogleConnectionSnapshot;
  gbp: GoogleConnectionSnapshot;
  reservationOps: ReservationOpsSnapshot | null;
  /** 予約通知の全体スイッチ(お客様の設定)。 */
  masterEnabled: boolean;
  /** スタッフの LINE 通知先を招待で追加できるか(LINE ログインの設定が有効か)。 */
  lineInvitesAvailable: boolean;
  /** 届いた口コミの Google 連携を有効にしてよいか(承認の確認まで本番では無効)。 */
  googleReviewsAvailable: boolean;
  /** 状態の判定に使う現在時刻(テスト用。省略時は現在)。 */
  now?: Date;
}

/** 予約通知の運用状態のうち、お客様向けの表示に必要なもの(内部の移行状態そのものは表示しない)。 */
export interface ReservationOpsSnapshot {
  state: ReservationOpsState;
  legacy: boolean;
  /** 停止の理由(pause_reason)。legacy_* は監視による停止、それ以外は運営による停止。 */
  pauseReason?: string | null;
  activatedAt?: string | null;
  /** 最後に予約メールの確認を始めた日時(gmail_scan_state.last_tick_at)。 */
  lastMailCheckAt?: string | null;
}

export type SelectionSource = "explicit" | "implicit" | "single" | "none";

export type FeatureStatus =
  | "not_selected"
  | "coming_soon"
  | "setup_required"
  | "google_connect_required"
  | "reconnect_required"
  | "setup_complete"
  | "ready_to_start"
  | "active"
  | "paused"
  | "checking"
  | "ready";

// お客様向けの表示。旧サービスからの切り替えの内部状態(切り替え待ち・旧側停止・照合)はここに出さない
// (運営の CLI の list・DB の状態には残る)。
export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  not_selected: "未選択",
  coming_soon: "準備中",
  setup_required: "設定が必要",
  google_connect_required: "Google接続待ち",
  reconnect_required: "再接続が必要",
  setup_complete: "設定完了",
  ready_to_start: "開始待ち",
  active: "稼働中",
  paused: "停止中",
  checking: "確認中",
  ready: "利用中",
};

/** 予約メールの確認がこれより長く行われていなければ、動作を確認できない状態として表示する。 */
export const MAIL_CHECK_STALE_MS = 15 * 60 * 1000;

export const SETUP_COMPLETE_MESSAGE = "Googleとの連携が完了しました。\nお客様の操作は以上です。LINEの再登録は不要です。";

export interface SetupItemState {
  key: SetupItemKey;
  label: string;
  description: string;
  href: string;
  required: boolean;
  group?: "google" | "line";
  complete: boolean;
}

export interface FeatureState {
  key: FeatureKey;
  definition: FeatureDefinition;
  entitled: boolean;
  available: boolean;
  selected: boolean;
  status: FeatureStatus;
  statusLabel: string;
  /** 画面に出す一文(同意できたことと、通知が始まったことを混同させない書き方にする)。 */
  message: string | null;
  /** 運営への問い合わせの導線を一緒に出すべきか(運営による停止・動作を確認できない状態・設定を変更できない間)。 */
  suggestSupport: boolean;
  setupItems: SetupItemState[];
}

export function isFeatureEntitled(plan: SalonPlan, def: FeatureDefinition): boolean {
  return isFeatureEnabledForPlan(plan, def.accessFeature) && isFeatureServedByMode(def.accessFeature);
}

export function isFeatureAvailable(def: FeatureDefinition, ctx: Pick<SetupContext, "googleReviewsAvailable">): boolean {
  if (def.availability === "available") return true;
  return def.key === "google_reviews" && ctx.googleReviewsAvailable;
}

/**
 * お客様が選んだ機能。一度でも保存した店舗は保存した行だけを使い、推定しない
 * (OFFにした機能が推定で再びONにならない。後から登録した新機能は「未選択」)。
 * 保存したことが無い既存の店舗だけ、使っている形跡から推定する(初期設定のやり直しを求めない)。
 */
export function resolveSelection(ctx: SetupContext): { selected: Set<FeatureKey>; source: SelectionSource } {
  const selectable = FEATURE_REGISTRY.filter((def) => isFeatureEntitled(ctx.plan, def) && isFeatureAvailable(def, ctx));
  if (ctx.selectionSavedAt) {
    const selected = new Set<FeatureKey>();
    for (const def of selectable) if (ctx.explicitSelections[def.key] === true) selected.add(def.key);
    return { selected, source: "explicit" };
  }
  const inferred = new Set<FeatureKey>();
  for (const def of selectable) {
    if (def.key === "reviews" && ctx.hasActiveSurvey) inferred.add(def.key);
    if (def.key === "blog" && ctx.hasSalonSettingsRow) inferred.add(def.key);
    if (def.key === "reservation_notifications" && (ctx.hasAnyLineConnection || ctx.reservationOps)) inferred.add(def.key);
  }
  if (inferred.size > 0) return { selected: inferred, source: "implicit" };
  if (selectable.length === 1) return { selected: new Set([selectable[0].key]), source: "single" };
  return { selected: new Set(), source: "none" };
}

function googleIssue(conn: GoogleConnectionSnapshot): "not_connected" | "reconnect" | null {
  if (!conn.bound) return "not_connected";
  if (conn.authState !== "active" || !conn.scopeGranted) return "reconnect";
  return null;
}

function itemComplete(key: SetupItemKey, ctx: SetupContext): boolean {
  switch (key) {
    case "review_survey":
      return ctx.hasActiveSurvey && ctx.onboardingCompleted;
    case "review_google_url":
      return Boolean(ctx.googleReviewUrl);
    case "blog_settings":
      return ctx.hasBlogSettings;
    case "google_gmail":
      return googleIssue(ctx.gmail) === null;
    case "line_recipients":
      return ctx.lineRecipientCount > 0;
    case "reservation_start":
      return ctx.reservationOps?.state === "active";
    case "google_gbp":
      return googleIssue(ctx.gbp) === null;
    case "gbp_location":
      return ctx.gbp.bound && ctx.gbp.selectionState === "selected";
  }
}

type StatusResult = { status: FeatureStatus; message: string | null; suggestSupport?: boolean };

function formatJstTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function lineRecipientGuidance(ctx: SetupContext): StatusResult {
  return ctx.lineInvitesAvailable
    ? { status: "setup_required", message: "Googleとの連携が完了しました。LINEの通知先を追加してください。" }
    : { status: "setup_required", message: "Googleとの連携が完了しました。LINEの通知先の追加は、運営にお問い合わせください。", suggestSupport: true };
}

// 予約通知のお客様向けの状態。旧サービスからの切り替え(運営の作業)の内部状態は出さない。
// 「新側が実際に通知しているか」を基準にし、未稼働なのに「稼働中」と出さない。停止が確定している状態
// (お客様の OFF・運営の停止)と、動作を確認できない状態(監視による停止・予約メールの確認が止まっている)を分け、
// 旧側が通知を続けているとは断定しない。
function reservationStatus(ctx: SetupContext): StatusResult {
  const google = googleIssue(ctx.gmail);
  const ops = ctx.reservationOps;
  if (google === "reconnect") {
    if (ctx.gmail.authState === "active") {
      // Gmail の権限だけが足りない(同じアカウントの他の機能の連携は有効のまま)。
      return {
        status: "reconnect_required",
        message: `予約メールを読むためのGmailの権限が足りません。「権限を追加する」から許可してください。${ops?.state === "active" ? "予約通知は許可されるまで止まります。" : ""}`,
      };
    }
    return { status: "reconnect_required", message: "Googleとの連携が切れています。再接続してください。予約通知は再接続まで止まります。" };
  }
  if (ops?.state === "paused") {
    if (ops.pauseReason?.startsWith("legacy_")) {
      return { status: "checking", message: "予約通知の動作を確認できない状態です。運営で確認しています。", suggestSupport: true };
    }
    return { status: "paused", message: "予約通知を一時停止しています。詳しくは運営にお問い合わせください。", suggestSupport: true };
  }
  if (ops?.state === "active") {
    if (!ctx.masterEnabled) return { status: "paused", message: "予約通知を受け取る設定がOFFになっています。" };
    if (ctx.lineRecipientCount === 0) {
      return ctx.lineInvitesAvailable
        ? { status: "setup_required", message: "LINEの通知先がありません。通知先を追加してください。" }
        : { status: "setup_required", message: "LINEの通知先がありません。運営にお問い合わせください。", suggestSupport: true };
    }
    const now = (ctx.now ?? new Date()).getTime();
    const since = ops.lastMailCheckAt ?? ops.activatedAt ?? null;
    if (since && now - new Date(since).getTime() > MAIL_CHECK_STALE_MS) {
      return {
        status: "checking",
        message: ops.lastMailCheckAt
          ? `${formatJstTime(ops.lastMailCheckAt)}から予約メールの確認ができていません。運営で確認しています。`
          : "予約メールの確認ができていません。運営で確認しています。",
        suggestSupport: true,
      };
    }
    return { status: "active", message: null };
  }
  if (google === "not_connected") {
    return {
      status: "google_connect_required",
      message: ops?.legacy ? "予約メールが届くGmailで、Googleとの連携をお願いします。LINEの再登録は不要です。" : null,
    };
  }
  if (ops?.legacy) {
    // 必要な権限を得た既存店舗: お客様の操作は完了(新側の開始・旧側との切り替えは運営が行う)。
    if (ctx.lineRecipientCount === 0) return lineRecipientGuidance(ctx);
    return { status: "setup_complete", message: SETUP_COMPLETE_MESSAGE };
  }
  if (ctx.lineRecipientCount === 0) return lineRecipientGuidance(ctx);
  return { status: "ready_to_start", message: "Googleとの連携が完了しました。予約通知はまだ始まっていません。開始すると通知が届くようになります。" };
}

function googleReviewsStatus(ctx: SetupContext): { status: FeatureStatus; message: string | null } {
  const google = googleIssue(ctx.gbp);
  if (google === "not_connected") return { status: "google_connect_required", message: null };
  if (google === "reconnect") return { status: "reconnect_required", message: "Googleとの連携が切れています。再接続してください。" };
  if (ctx.gbp.selectionState !== "selected") {
    return { status: "setup_required", message: "Googleとの連携が完了しました。口コミを受け取る店舗の選択が必要です(準備中)。" };
  }
  return { status: "ready", message: null };
}

export function resolveFeatureStates(ctx: SetupContext): { states: FeatureState[]; selectionSource: SelectionSource } {
  const { selected, source } = resolveSelection(ctx);
  const states: FeatureState[] = [];
  for (const def of FEATURE_REGISTRY) {
    const entitled = isFeatureEntitled(ctx.plan, def);
    if (!entitled) continue;
    const available = isFeatureAvailable(def, ctx);
    const isSelected = available && selected.has(def.key);
    const setupItems: SetupItemState[] = def.setupItems.map((key) => {
      const item = { ...SETUP_ITEMS[key], complete: itemComplete(key, ctx) };
      // LINE の通知先を招待で追加できない間は、押せないボタンへ案内しない(運営への問い合わせを案内する)。
      if (key === "line_recipients" && !ctx.lineInvitesAvailable) {
        item.label = "LINEの通知先の追加は運営にお問い合わせください";
        item.description = "LINEの通知先の追加は、運営にお問い合わせください。";
      }
      return item;
    });

    let status: FeatureStatus;
    let message: string | null = null;
    let suggestSupport = false;
    if (!available) {
      status = "coming_soon";
      message = def.key === "google_reviews" ? "Googleの承認を確認中のため、準備中です。" : null;
    } else if (!isSelected) {
      status = "not_selected";
    } else if (def.key === "reservation_notifications") {
      const result = reservationStatus(ctx);
      ({ status, message } = result);
      suggestSupport = Boolean(result.suggestSupport);
    } else if (def.key === "google_reviews") {
      ({ status, message } = googleReviewsStatus(ctx));
    } else {
      status = setupItems.some((i) => i.required && !i.complete) ? "setup_required" : "ready";
    }
    states.push({
      key: def.key,
      definition: def,
      entitled,
      available,
      selected: isSelected,
      status,
      statusLabel: FEATURE_STATUS_LABELS[status],
      message,
      suggestSupport,
      setupItems,
    });
  }
  return { states, selectionSource: source };
}

export interface ChecklistEntry {
  key: string;
  label: string;
  description: string;
  href: string;
  required: boolean;
  features: string[];
}

/**
 * 選んだ機能の未完了の設定項目だけを並べる(必須を先に)。同じ画面でまとめて設定できる
 * Google 連携・LINE の送信先は1件にまとめる(完了済みの共通設定は再利用し、重ねて求めない)。
 */
export function buildSetupChecklist(states: FeatureState[]): ChecklistEntry[] {
  const entries = new Map<string, ChecklistEntry>();
  for (const state of states) {
    if (!state.selected) continue;
    for (const item of state.setupItems) {
      if (item.complete) continue;
      // お客様の操作が完了した機能(既存店舗の設定完了など)は、未完了の設定として繰り返し案内しない。
      if (state.status === "setup_complete") continue;
      // 予約通知の「開始」は、お客様が自分で開始できる状態(Google と LINE がそろった新規店舗)のときだけ出す。
      if (item.key === "reservation_start" && state.status !== "ready_to_start") continue;
      if (item.key === "gbp_location" && state.status !== "setup_required") continue;
      const groupKey = item.group ?? item.key;
      const existing = entries.get(groupKey);
      if (existing) {
        if (!existing.features.includes(state.definition.label)) existing.features.push(state.definition.label);
        existing.required = existing.required || item.required;
        continue;
      }
      entries.set(groupKey, {
        key: groupKey,
        label: item.group === "google" ? "Googleと連携" : item.label,
        description: item.description,
        href: item.href,
        required: item.required,
        features: [state.definition.label],
      });
    }
  }
  return [...entries.values()].sort((a, b) => Number(b.required) - Number(a.required));
}
