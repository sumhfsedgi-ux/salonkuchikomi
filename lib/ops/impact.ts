import type { SalonPlan } from "@/lib/access/plan";
import type { EntitlementReason, OverrideMode } from "@/lib/features/entitlements";
import { PLAN_LABELS } from "@/lib/ops/labels";
import { ACCESS_STATE_LABELS, accessState } from "@/lib/ops/featureDisplay";

// 管理画面の「変更を保存」の確認に出す、変更内容と影響(DBに触れない)。
// 利用許可と稼働状態は別のもの: 許可を外すと止まるが、許可を戻しただけでは連携・通知を始めない・再開しない。

export interface FeatureChangeInput {
  key: string;
  label: string;
  hasRuntime: boolean;
  beforeOverride: OverrideMode;
  afterOverride: OverrideMode;
  before: { allowed: boolean; reason: EntitlementReason };
  after: { allowed: boolean; reason: EntitlementReason };
  /** 権限による停止が開いている(予約通知)。 */
  holdOpen: boolean;
  /** 予約通知の運用を始めている(運用状態があり、開始前ではない)。 */
  runtimeStarted: boolean;
}

export interface ChangeSummary {
  title: string;
  details: string[];
  /** 利用できなくなる変更(確認で目立たせる)。 */
  revokes: boolean;
}

/** 管理画面のスイッチと同じ言葉(利用を許可/利用を許可しない/プラン対象外/準備中/提供終了)。 */
function stateText(a: { allowed: boolean; reason: EntitlementReason }): string {
  return ACCESS_STATE_LABELS[accessState(a)];
}

const OVERRIDE_TEXT = { allow: ACCESS_STATE_LABELS.allowed, deny: ACCESS_STATE_LABELS.not_allowed } as const;

const KEEP_DATA = "保存済みの設定・データは削除しません。";

function revokeDetails(f: FeatureChangeInput): string[] {
  switch (f.key) {
    case "reviews":
      return [
        "サロンの口コミの画面と設定の変更、お客様用ページ、口コミ文章の生成を止めます(URL・APIを直接呼ばれても止めます)。",
        "お客様用ページには「現在ご利用いただけません」と表示します(理由は表示しません)。",
        "サロンのホームでは「ご契約外」と表示します(口コミプランでは「現在ご利用いただける機能はありません」と表示します)。サロン設定とログアウトは使えます。",
        "アンケートなどの保存済みデータは削除しません。",
      ];
    case "blog":
      return ["ブログの画面と作成を止めます。サロンのホームでは「ご契約外」と表示します。", "保存済みのブログ・設定は削除しません。"];
    case "reservation_notifications":
      if (!f.runtimeStarted) return ["予約通知はまだ開始していないため、停止の記録は作りません。", "LINEの通知先・Google連携・設定は残ります。"];
      return [
        "保存が完了した時点から、新しい予約メールの確認と通知の送信を始めません。送信を開始済みの通知は完了まで続きます(件数は保存後に表示します)。",
        "停止中に届いた予約は、あとで再開しても通知しません。",
        "「権限による停止」を記録します。再び許可しても自動では再開せず、運営が停止を解除するまで止まったままです。",
        "LINEの通知先・Google連携・受信ON/OFF・サロンによる利用停止の設定は、そのまま残ります。",
      ];
    default:
      return f.hasRuntime
        ? ["この機能の画面と自動の処理を止めます。再び許可しても、運営が停止を解除するまで自動では再開しません。", KEEP_DATA]
        : ["この機能の画面と操作を止めます。", KEEP_DATA];
  }
}

function grantDetails(f: FeatureChangeInput): string[] {
  if (f.key === "reservation_notifications" || f.hasRuntime) {
    if (f.holdOpen) {
      return ["利用を許可しますが、送信は再開しません。「連携と稼働状況」で権限による停止を解除するまで止まったままです。"];
    }
    if (!f.runtimeStarted) {
      return ["利用を許可します。Google・LINEの設定と開始はサロンの操作で行います(この保存だけでは連携や通知を始めません)。"];
    }
    return ["利用を許可します。受信OFF・サロンによる利用停止・運営による停止は、そのまま残ります。"];
  }
  return ["利用を許可します。保存済みの設定・データがあれば、そのまま使えます。"];
}

export function describeChanges(params: { planBefore: SalonPlan; planAfter: SalonPlan; features: FeatureChangeInput[] }): ChangeSummary[] {
  const out: ChangeSummary[] = [];
  if (params.planBefore !== params.planAfter) {
    const details = [
      params.planAfter === "salonpack"
        ? "画面の構成が SalonPack(機能一覧のホーム)に変わります。"
        : "画面の構成が口コミプラン(口コミの画面を直接表示)に変わります。",
    ];
    for (const f of params.features) {
      const before = accessState(f.before);
      const after = accessState(f.after);
      // 対象外になる機能の個別設定は消さずに残り、対象プランへ戻したときに効く。
      if (f.afterOverride !== "inherit" && after === "not_in_plan") {
        details.push(`${f.label}の個別設定「${OVERRIDE_TEXT[f.afterOverride]}」は削除されずに残り、${PLAN_LABELS[params.planBefore]}へ戻したときに適用されます。`);
      }
      // 対象プランになっても、個別設定・提供状態によっては許可されない(プランを変えれば必ず使える、とは書かない)。
      if (before === "not_in_plan" && after !== "not_in_plan" && after !== "allowed") {
        const why =
          after === "not_allowed"
            ? f.afterOverride === "deny"
              ? `保存されている個別設定「${ACCESS_STATE_LABELS.not_allowed}」`
              : "このプランでは許可していない設定"
            : ACCESS_STATE_LABELS[after];
        details.push(`${f.label}は対象プランになりますが、${why}のため利用は許可されません。`);
      }
    }
    out.push({ title: `契約プラン: ${PLAN_LABELS[params.planBefore]} → ${PLAN_LABELS[params.planAfter]}`, details, revokes: false });
  }
  for (const f of params.features) {
    const settingChanged = f.beforeOverride !== f.afterOverride;
    const accessChanged = f.before.allowed !== f.after.allowed;
    if (!settingChanged && !accessChanged) continue;
    // 見出しの「→ プラン対象外」などが理由を兼ねる(同じ説明を重ねない)。
    const title = accessChanged
      ? `${f.label}: ${stateText(f.before)} → ${stateText(f.after)}`
      : f.afterOverride === "inherit"
        ? `${f.label}: 以前の個別設定を外し、プランの設定に戻す`
        : `${f.label}: 個別設定を変更`;
    const details: string[] = [];
    if (accessChanged) details.push(...(f.after.allowed ? grantDetails(f) : revokeDetails(f)));
    else details.push("利用できるかどうかは今は変わりません。");
    out.push({ title, details, revokes: f.before.allowed && !f.after.allowed });
  }
  return out;
}
