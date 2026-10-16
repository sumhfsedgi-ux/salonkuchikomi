import { describe, expect, it } from "vitest";
import {
  ACCESS_STATE_LABELS,
  accessState,
  notInPlanHint,
  planNote,
  plansIncluding,
  retainedOverrideText,
  startNote,
  unsavedChangeText,
} from "@/lib/ops/featureDisplay";
import { previewAccess, type PlanRules } from "@/lib/ops/preview";

// 運営管理の「契約プラン・使える機能」の言葉。利用許可と稼働を混同せず、使えない理由を書き分けること。

const RULES: PlanRules = { reviews: { reviews: true }, salonpack: { reviews: true, blog: true, reservation_notifications: true } };
const AVAILABLE = { lifecycle: "available" as const, hasRuntime: false };
const FEATURES = [
  { key: "reviews", label: "口コミ" },
  { key: "blog", label: "ブログ" },
  { key: "reservation_notifications", label: "予約通知" },
];

describe("状態の言葉(理由ごとに分ける)", () => {
  it("許可・許可しない・プラン対象外・準備中・提供終了を区別する", () => {
    expect(accessState(previewAccess(AVAILABLE, RULES, "salonpack", "blog", "inherit"))).toBe("allowed");
    expect(accessState(previewAccess(AVAILABLE, RULES, "salonpack", "blog", "deny"))).toBe("not_allowed");
    expect(accessState(previewAccess(AVAILABLE, RULES, "reviews", "blog", "inherit"))).toBe("not_in_plan");
    // 対象プランの外では、個別設定が残っていても「プラン対象外」(個別設定で制限を解除しない)
    expect(accessState(previewAccess(AVAILABLE, RULES, "reviews", "blog", "allow"))).toBe("not_in_plan");
    expect(accessState(previewAccess({ lifecycle: "coming_soon", hasRuntime: false }, RULES, "salonpack", "blog", "allow"))).toBe("coming_soon");
    expect(accessState(previewAccess({ lifecycle: "ended", hasRuntime: false }, RULES, "salonpack", "blog", "inherit"))).toBe("ended");
    expect(ACCESS_STATE_LABELS).toEqual({
      allowed: "利用を許可",
      not_allowed: "利用を許可しない",
      not_in_plan: "プラン対象外",
      coming_soon: "準備中",
      ended: "提供終了",
      service_pending: "利用できない区分",
    });
    expect(accessState({ allowed: false, reason: "service_pending" })).toBe("service_pending");
  });

  it("「使えません」「利用中」「停止」の言葉を使わない(稼働の状態と混同しない)", () => {
    for (const label of Object.values(ACCESS_STATE_LABELS)) expect(label).not.toMatch(/使えません|利用中|停止/);
  });
});

describe("プランの説明・プラン対象外の補足", () => {
  it("プラン選択欄の説明は、プランの対象から作る", () => {
    expect(planNote(FEATURES, RULES)).toBe(
      "口コミプランの対象機能は口コミです。ブログ・予約通知の利用を許可する場合は、SalonPackを選択してください。",
    );
  });

  it("プラン対象外の補足は、変更先のプランで許可できることだけを書く(必ず使えるとは書かない)", () => {
    expect(plansIncluding(RULES, "blog")).toEqual(["salonpack"]);
    expect(notInPlanHint(["salonpack"], true)).toBe("SalonPackへの変更で利用を許可できます。");
    expect(notInPlanHint(["salonpack"], false)).toContain("提供していないため利用を許可できません");
    expect(notInPlanHint([], true)).toBeNull();
  });

  it("対象外の機能に残っている個別設定は、消さずに残り、戻したときに適用されると書く", () => {
    expect(retainedOverrideText("deny", ["salonpack"])).toBe("以前の個別設定「利用を許可しない」が保存されています。SalonPackへ戻したときに適用されます。");
    expect(retainedOverrideText("allow", [])).toBe("以前の個別設定「利用を許可」が保存されています。対象プランへ戻したときに適用されます。");
  });

  it("動き続ける機能は、許可しただけでは始まらないことと前提を書く", () => {
    expect(startNote("予約通知", ["Google連携(予約受信用のGmail)", "LINEの通知先"], true)).toBe(
      "利用を許可しただけでは予約通知は始まりません。Google連携(予約受信用のGmail)・LINEの通知先・開始の設定が必要です。",
    );
    expect(startNote("ブログ", [], false)).toBeNull();
  });
});

describe("未保存の変更の説明", () => {
  const p = (plan: "reviews" | "salonpack", key: string, override: "inherit" | "allow" | "deny") => previewAccess(AVAILABLE, RULES, plan, key, override);

  it("プランの変更が理由なら「プラン対象外になります」", () => {
    expect(
      unsavedChangeText({ label: "予約通知", before: p("salonpack", "reservation_notifications", "inherit"), after: p("reviews", "reservation_notifications", "inherit"), beforeOverride: "inherit", afterOverride: "inherit", holdOpen: false }),
    ).toBe("保存すると、予約通知はプラン対象外になります。");
  });

  it("個別に許可を外すなら「利用許可が取り消されます」", () => {
    expect(
      unsavedChangeText({ label: "予約通知", before: p("salonpack", "reservation_notifications", "inherit"), after: p("salonpack", "reservation_notifications", "deny"), beforeOverride: "inherit", afterOverride: "deny", holdOpen: false }),
    ).toBe("保存すると、予約通知の利用許可が取り消されます。");
  });

  it("許可し直しても、権限による停止が開いていれば再開しないと書く", () => {
    const text = unsavedChangeText({ label: "予約通知", before: p("salonpack", "reservation_notifications", "deny"), after: p("salonpack", "reservation_notifications", "inherit"), beforeOverride: "deny", afterOverride: "inherit", holdOpen: true });
    expect(text).toBe("保存すると、予約通知の利用を許可します。権限による停止は残るため、それだけでは再開しません。");
  });

  it("SalonPack に戻しても、残っていた「許可しない」が効くなら、許可されないと書く(必ず使えるとは書かない)", () => {
    const text = unsavedChangeText({ label: "ブログ", before: p("reviews", "blog", "deny"), after: p("salonpack", "blog", "deny"), beforeOverride: "deny", afterOverride: "deny", holdOpen: false });
    expect(text).toContain("対象プランになりますが");
    expect(text).toContain("利用は許可されません");
  });

  it("「プランの設定に戻す」は、使えるかどうかが今は変わらないことを書く", () => {
    const text = unsavedChangeText({ label: "ブログ", before: p("reviews", "blog", "deny"), after: p("reviews", "blog", "inherit"), beforeOverride: "deny", afterOverride: "inherit", holdOpen: false });
    expect(text).toContain("プランの設定に戻します");
    expect(text).toContain("今は変わりません");
  });

  it("プランの変更と「プランの設定に戻す」を同時に選んだときは、両方を書く", () => {
    const text = unsavedChangeText({ label: "ブログ", before: p("salonpack", "blog", "deny"), after: p("reviews", "blog", "inherit"), beforeOverride: "deny", afterOverride: "inherit", holdOpen: false });
    expect(text).toBe("保存すると、ブログはプラン対象外になります。以前の個別設定も外し、プランの設定に戻します。");
  });

  it("変更が無ければ何も出さない", () => {
    expect(unsavedChangeText({ label: "ブログ", before: p("salonpack", "blog", "inherit"), after: p("salonpack", "blog", "inherit"), beforeOverride: "inherit", afterOverride: "inherit", holdOpen: false })).toBeNull();
  });
});
