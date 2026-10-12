import type { SalonPlan } from "@/lib/access/plan";
import { ENTITLEMENT_REASON_LABELS, OVERRIDE_LABELS, type EntitlementReason, type OverrideMode } from "@/lib/features/entitlements";
import { PLAN_LABELS } from "@/lib/ops/labels";

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

/** 管理画面のスイッチと同じ言葉(利用中/停止/使えない)。 */
function stateText(a: { allowed: boolean; reason: EntitlementReason }): string {
  if (a.allowed) return "利用中";
  return a.reason === "override_deny" ? "停止" : "使えない";
}

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
        "LINEの通知先・Google連携・受信ON/OFF・お客様の利用停止の設定は、そのまま残ります。",
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
      return ["利用できるようになりますが、送信は再開しません。「連携と稼働状況」で権限による停止を解除するまで止まったままです。"];
    }
    if (!f.runtimeStarted) {
      return ["利用できるようになります。Google・LINEの設定と開始はお客様の操作で行います(この保存だけでは連携や通知を始めません)。"];
    }
    return ["利用できるようになります。受信OFF・お客様の利用停止・運営による停止は、そのまま残ります。"];
  }
  return ["保存済みの設定で、再び使えるようになります。"];
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
      if (f.afterOverride !== "inherit" && f.after.reason === "not_in_plan") {
        details.push(`${f.label}の個別の設定(${OVERRIDE_LABELS[f.afterOverride]})は残りますが、${PLAN_LABELS[params.planAfter]}では使えない機能のため効きません。`);
      }
    }
    out.push({ title: `契約プラン: ${PLAN_LABELS[params.planBefore]} → ${PLAN_LABELS[params.planAfter]}`, details, revokes: false });
  }
  for (const f of params.features) {
    const settingChanged = f.beforeOverride !== f.afterOverride;
    const accessChanged = f.before.allowed !== f.after.allowed;
    if (!settingChanged && !accessChanged) continue;
    const title = accessChanged
      ? `${f.label}: ${stateText(f.before)} → ${stateText(f.after)}`
      : f.afterOverride === "inherit"
        ? `${f.label}: 残っていた個別の設定を標準に戻す`
        : `${f.label}: 個別の設定を変更`;
    const details: string[] = [];
    // 停止(個別)以外の理由で使えなくなるときは、理由を添える(例: プランを変えたため)。
    if (accessChanged && !f.after.allowed && f.after.reason !== "override_deny") details.push(`理由: ${ENTITLEMENT_REASON_LABELS[f.after.reason]}。`);
    if (accessChanged) details.push(...(f.after.allowed ? grantDetails(f) : revokeDetails(f)));
    else details.push("使えるかどうかは変わりません。");
    out.push({ title, details, revokes: f.before.allowed && !f.after.allowed });
  }
  return out;
}
