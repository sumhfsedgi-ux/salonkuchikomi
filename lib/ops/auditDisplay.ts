import type { SalonPlan } from "@/lib/access/plan";
import { LIFECYCLE_LABELS, type OverrideMode } from "@/lib/features/entitlements";
import { getFeatureDefinition, isFeatureKey } from "@/lib/features/registry";
import { ACCESS_STATE_LABELS } from "@/lib/ops/featureDisplay";
import { PLAN_LABELS } from "@/lib/ops/labels";
import type { PlanRules } from "@/lib/ops/preview";
import type { AuditEntry } from "@/lib/ops/queries";
import { isSwitchOn } from "@/lib/ops/toggle";
import { isServiceStatus, SERVICE_STATUS_LABELS } from "@/lib/onboarding/serviceStatus";
import { authEmailErrorLabel } from "@/lib/onboarding/authEmailErrors";

// 運営管理の「変更履歴」の表示(DBに触れない)。DB の記録(operator_audit_log)は書き換えず、表示だけを整える。
// 出すもの: 変更日時・変更者・何をどう変えたか・運営担当者のメモ。
// 出さないもの: 変更の方法(SQL・CLI)、DB のロール名(postgres など)、テーブル名・内部ID、JSON、機械向けの識別子。
// 変更者は記録にあるものだけを出し、推測しない(無ければ「変更者の記録なし」)。

export interface AuditView {
  /** 変更者の表示(「変更者: 〇〇」「変更者の記録なし」「システムによる変更」)。 */
  actor: string;
  change: string;
  /** 運営担当者が入力したメモ(内部の目印を外したもの)。無ければ null。 */
  memo: string | null;
}

/** 運用CLI が記録する作業者(scripts/notifications-ops/connect.ts の operatorName。「operator:<名前>」)。 */
const CLI_OPERATOR = /^operator:([A-Za-z0-9_.@-]{1,60})$/;
const CLI_OPERATOR_PREFIX = /^operator:([A-Za-z0-9_.@-]{1,60})(?:\s+|$)/;
/** 0024 で契約変更の記録を写したときに付けた目印。 */
const PLAN_CHANGE_MARKER = /\s*\[salon_plan_changes #\d+\]\s*$/;

export const NO_ACTOR_RECORD = "変更者の記録なし";

function featureLabel(key: string | undefined): string {
  return key && isFeatureKey(key) ? getFeatureDefinition(key).label : "機能";
}

function planLabel(value: unknown): string | null {
  return value === "reviews" || value === "salonpack" ? PLAN_LABELS[value as SalonPlan] : null;
}

/**
 * 個別設定の値を、管理画面のスイッチと同じ言葉(利用を許可/利用を許可しない)で表す。
 * 個別設定が効くのは対象プランのときだけなので、今の契約が対象外なら、その機能を含むプランの初期設定で読む。
 */
function overrideText(value: unknown, key: string | undefined, rules: PlanRules, plan: SalonPlan): string | null {
  if (value !== "inherit" && value !== "allow" && value !== "deny") return null;
  const k = key ?? "";
  const defaultOn = rules[plan]?.[k] ?? rules.salonpack?.[k] ?? rules.reviews?.[k] ?? true;
  return isSwitchOn(value as OverrideMode, defaultOn) ? ACCESS_STATE_LABELS.allowed : ACCESS_STATE_LABELS.not_allowed;
}

function statusLabel(value: unknown): string | null {
  return isServiceStatus(value) ? SERVICE_STATUS_LABELS[value] : null;
}

const INVITATION_KIND_TEXT: Record<string, string> = {
  invite: "招待のメール",
  salon_notice: "店舗登録のお知らせ",
  verify_link: "本人確認のご案内",
};

function changeText(e: Pick<AuditEntry, "target" | "before" | "after">, rules: PlanRules, plan: SalonPlan): string {
  if (e.target === "service_status") {
    const before = statusLabel(e.before);
    const after = statusLabel(e.after);
    if (!after) return "利用区分の変更";
    return before ? `利用区分: ${before} → ${after}` : `利用区分を${after}に設定`;
  }
  if (e.target === "registration") {
    const a = (e.after ?? {}) as { source?: unknown; plan?: unknown; service_status?: unknown };
    const detail = [planLabel(a.plan), statusLabel(a.service_status)].filter(Boolean).join("・");
    if (a.source === "self_signup") return `お客様が店舗を登録${detail ? `(${detail})` : ""}`;
    if (a.source === "operator") return `運営が店舗を本登録${detail ? `(${detail})` : ""}`;
    return "店舗の登録";
  }
  if (e.target === "invitation") {
    const a = (e.after ?? {}) as { kind?: unknown; result?: unknown; error?: unknown };
    const label = (typeof a.kind === "string" && INVITATION_KIND_TEXT[a.kind]) || "案内のメール";
    // 「送信を受け付けた」は、届いた・読まれたという意味ではない。
    if (a.result === "accepted") return `${label}: 送信を受け付けました`;
    if (a.result === "simulated") return `${label}: 検証モードのため送信していません`;
    if (a.result === "failed") return `${label}: 送信できませんでした(${authEmailErrorLabel(typeof a.error === "string" ? a.error : null)})`;
    return `${label}の送信`;
  }
  if (e.target === "plan") {
    const before = planLabel(e.before);
    const after = planLabel(e.after);
    if (!after) return "契約プランの変更";
    return before ? `契約プラン: ${before} → ${after}` : `契約プランを${after}に設定`;
  }
  const [kind, key, extra] = e.target.split(":");
  switch (kind) {
    case "feature": {
      const label = featureLabel(key);
      const before = overrideText(e.before, key, rules, plan);
      const after = overrideText(e.after, key, rules, plan);
      if (!before || !after) return `${label}の利用許可の変更`;
      return before === after ? `${label}: 個別設定を変更(${after}のまま)` : `${label}: ${before} → ${after}`;
    }
    case "hold": {
      const label = featureLabel(key);
      // 権限による停止は、利用許可がなくなったときにだけ DB が開く(supabase/migrations/0024 の salon_entitlement_settle)。
      if (e.after === "open") return `${label}を権限により停止(利用許可がなくなったため)`;
      if (e.after === "released") return `${label}の権限による停止を解除`;
      return `${label}の権限による停止の変更`;
    }
    case "catalog": {
      const label = featureLabel(key);
      const lifecycle = (v: unknown) => {
        const l = (v as { lifecycle?: unknown } | null)?.lifecycle;
        return typeof l === "string" && l in LIFECYCLE_LABELS ? LIFECYCLE_LABELS[l as keyof typeof LIFECYCLE_LABELS] : null;
      };
      const before = lifecycle(e.before);
      const after = lifecycle(e.after);
      return before && after ? `${label}の提供状態(全体): ${before} → ${after}` : `${label}の提供状態(全体)の変更`;
    }
    case "plan_rule": {
      const label = featureLabel(extra);
      const p = planLabel(key) ?? "プラン";
      const enabled = (e.after as { default_enabled?: unknown } | null)?.default_enabled;
      if (typeof enabled !== "boolean") return `${label}の${p}での初期設定の変更`;
      return `${label}の${p}での初期設定: ${enabled ? ACCESS_STATE_LABELS.allowed : ACCESS_STATE_LABELS.not_allowed}`;
    }
    default:
      return "設定の変更";
  }
}

function actorText(e: Pick<AuditEntry, "actorKind" | "actorEmail" | "actorLabel" | "note">): string {
  if (e.actorKind === "system") return systemActorText(e);
  const name = actorName(e);
  return name ? `変更者: ${name}` : NO_ACTOR_RECORD;
}

/** 記録にある変更者の名前(無ければ null。推測しない)。 */
function actorName(e: Pick<AuditEntry, "actorKind" | "actorEmail" | "actorLabel" | "note">): string | null {
  switch (e.actorKind) {
    case "operator":
      return e.actorEmail;
    case "cli":
      // 運用CLI は作業者(--by)を記録する。それ以外のラベルは人の名前ではないため出さない。
      return e.actorLabel?.match(CLI_OPERATOR)?.[1] ?? null;
    case "sql":
      // migration が書いた記録(0025 の移行など)。
      if (e.actorLabel?.startsWith("migration:")) return `移行(${e.actorLabel.slice("migration:".length)})`;
      // SQL での変更は DB のロール名しか残らない。運用CLI がメモの先頭に作業者を記録している場合だけ、その名前を出す。
      return e.note?.match(CLI_OPERATOR_PREFIX)?.[1] ?? null;
    case "owner":
      return "お客様(店舗のオーナー)";
    default:
      return null;
  }
}

/** ほかの変更に伴って自動で記録したもの(例: 利用許可を外したときの権限による停止)。きっかけの変更者が記録にあれば添える。 */
function systemActorText(e: Pick<AuditEntry, "actorEmail" | "actorLabel">): string {
  const cause = e.actorEmail ?? e.actorLabel?.match(/operator:([A-Za-z0-9_.@-]{1,60})$/)?.[1] ?? null;
  return cause && !/^[0-9a-f-]{36}$/i.test(cause) ? `システムによる変更(${cause} の変更に伴う)` : "システムによる変更";
}

function memoText(e: Pick<AuditEntry, "actorKind" | "note">): string | null {
  // 自動の記録のメモは、システムが書いた説明(人の入力ではない)。何が起きたかは変更内容の文で出す。
  if (e.actorKind === "system" || !e.note) return null;
  // 内部の目印(写したときの印・運用CLIが先頭に付けた作業者)だけを外し、ほかの文は削らない。
  let text = e.note.replace(PLAN_CHANGE_MARKER, "");
  if (e.actorKind === "cli" || e.actorKind === "sql") text = text.replace(CLI_OPERATOR_PREFIX, "");
  text = text.trim();
  return text || null;
}

export function describeAuditEntry(e: AuditEntry, ctx: { rules: PlanRules; plan: SalonPlan }): AuditView {
  return { actor: actorText(e), change: changeText(e, ctx.rules, ctx.plan), memo: memoText(e) };
}
