import type { GoogleAuthState } from "@/lib/google/db/accounts";
import type { SalonPlan } from "@/lib/access/plan";
import { resolveFeatureAccess, type FeatureAccessStatus } from "@/lib/features/access";
import type { SalonEntitlements } from "@/lib/features/entitlements";
import {
  FEATURE_REGISTRY,
  SETUP_ITEMS,
  type FeatureDefinition,
  type FeatureKey,
  type SetupItemKey,
} from "@/lib/features/registry";

// 機能ごとの状態の判定(DBに触れない純粋な関数。画面・Server Action・定期処理で共通に使う)。
// 次の4つを混同しないように、それぞれ別の入力から判定する:
//   契約上の利用権限・提供状況(lib/features/access.ts)/ 設定の完了 /
//   外部サービス(Google)の接続と許可 / 実際の稼働状態(予約通知の運用状態・内部スイッチ)
// お客様が「使う機能」を選ぶ仕組みは廃止した。ホームへの表示や利用権限だけでは、
// 予約通知のメール確認・送信は始まらない(運用状態と内部スイッチは別に持つ)。

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

/**
 * 予約通知の内部スイッチ(salon_feature_selections の予約通知の行)。DB はメール確認・送信のたびに
 * 「運用状態が稼働中 AND 契約 AND このスイッチ」を確かめる。「予約通知の利用を停止する」で false、
 * 開始・再開の操作で true にする。行が無い店舗は null(DB は OFF として扱う)。
 * updatedAt は、比べてから書く(読んだあとに別の操作で変わっていたら書かない)ために使う。
 */
export interface ReservationSwitchSnapshot {
  selected: boolean;
  updatedAt: string;
}

export interface SetupContext {
  plan: SalonPlan;
  /** 利用区分が利用中か(利用開始待ちの店舗は、どの機能も使えない)。 */
  serviceActive: boolean;
  /** DB から読んだ機能ごとの利用権限(lib/features/loadEntitlements.ts。権限による停止の有無も含む)。 */
  entitlements: SalonEntitlements;
  reservationSwitch: ReservationSwitchSnapshot | null;
  hasActiveSurvey: boolean;
  onboardingCompleted: boolean;
  googleReviewUrl: string | null;
  hasBlogSettings: boolean;
  lineRecipientCount: number;
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

export type FeatureStatus =
  | "not_allowed"
  | "coming_soon"
  | "ended"
  | "setup_required"
  | "google_connect_required"
  | "reconnect_required"
  | "setup_complete"
  | "ready_to_start"
  | "active"
  | "stopped"
  | "paused"
  | "checking"
  | "ready";

// お客様向けの表示。旧サービスからの切り替えの内部状態(切り替え待ち・旧側停止・照合)はここに出さない
// (運営の CLI の list・DB の状態には残る)。
export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  not_allowed: "ご契約外",
  coming_soon: "準備中",
  ended: "提供終了",
  setup_required: "設定が必要",
  google_connect_required: "Google接続待ち",
  reconnect_required: "再接続が必要",
  setup_complete: "設定完了",
  ready_to_start: "開始待ち",
  active: "稼働中",
  stopped: "停止中",
  paused: "停止中",
  checking: "確認中",
  ready: "利用中",
};

/** 予約メールの確認がこれより長く行われていなければ、動作を確認できない状態として表示する。 */
export const MAIL_CHECK_STALE_MS = 15 * 60 * 1000;

export const SETUP_COMPLETE_MESSAGE = "Googleとの連携が完了しました。\nお客様の操作は以上です。LINEの再登録は不要です。";

export const RESERVATION_HELD_MESSAGE = "予約通知を停止しています。再開については運営にお問い合わせください。";

export const RESERVATION_STOPPED_MESSAGE =
  "予約通知の利用を停止しています。再開すると、再開したあとに届いた予約から通知します(停止中に届いた予約は通知しません)。";

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
  /** 契約上の利用権限と提供状況(lib/features/access.ts)。allowed 以外は status も同じ値になる。 */
  access: FeatureAccessStatus;
  status: FeatureStatus;
  statusLabel: string;
  /** 画面に出す一文(同意できたことと、通知が始まったことを混同させない書き方にする)。 */
  message: string | null;
  /** 運営への問い合わせの導線を一緒に出すべきか(運営による停止・動作を確認できない状態・設定を変更できない間)。 */
  suggestSupport: boolean;
  setupItems: SetupItemState[];
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

/**
 * お客様が「予約通知の利用を停止する」で止めている(内部スイッチが OFF で、開始済み・切り替え待ち)。
 * まだ開始していない店舗の OFF(行が無い・開始前)は停止として扱わず、通常の設定の流れにする。
 */
export function isReservationStoppedByCustomer(ctx: Pick<SetupContext, "reservationSwitch" | "reservationOps">): boolean {
  const state = ctx.reservationOps?.state;
  return ctx.reservationSwitch?.selected === false && (state === "active" || state === "awaiting_cutover");
}

// 予約通知のお客様向けの状態。旧サービスからの切り替え(運営の作業)の内部状態は出さない。
// 「新側が実際に通知しているか」を基準にし、未稼働なのに「稼働中」と出さない。停止が確定している状態
// (お客様の停止・受信 OFF・運営の停止)と、動作を確認できない状態(監視による停止・予約メールの確認が止まっている)を分け、
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
  // 権限による停止(運営が利用不可にしたあと、まだ運営が解除していない)。再び許可しただけでは再開しない。
  // お客様の「再開」では解除できないため、お問い合わせを案内する(契約・運営内部の事情は書かない)。
  if (ctx.entitlements.reservation_notifications?.holdOpen) {
    return { status: "paused", message: RESERVATION_HELD_MESSAGE, suggestSupport: true };
  }
  // 運営による停止・確認中より後、稼働中の判定より先に見る(お客様の停止を「稼働中」と出さない)。
  if (isReservationStoppedByCustomer(ctx)) return { status: "stopped", message: RESERVATION_STOPPED_MESSAGE };
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
    return { status: "setup_required", message: "Googleアカウントに接続しました。「口コミ」タブで、連携する店舗を選んでください。" };
  }
  return { status: "ready", message: null };
}

/** 全機能の状態(registry の順)。契約外・準備中の機能も含める(画面ごとに出す範囲は lib/features/access.ts で決める)。 */
export function resolveFeatureStates(ctx: SetupContext): { states: FeatureState[] } {
  const states: FeatureState[] = [];
  for (const def of FEATURE_REGISTRY) {
    const access = resolveFeatureAccess(def, {
      plan: ctx.plan,
      serviceActive: ctx.serviceActive,
      googleReviewsAvailable: ctx.googleReviewsAvailable,
      entitlements: ctx.entitlements,
    });
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
    if (access.status !== "allowed") {
      status = access.status;
      message = access.reason;
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
      access: access.status,
      status,
      statusLabel: FEATURE_STATUS_LABELS[status],
      message,
      suggestSupport,
      setupItems,
    });
  }
  return { states };
}
