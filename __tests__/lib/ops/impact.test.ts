import { describe, expect, it } from "vitest";
import { describeChanges, type FeatureChangeInput } from "@/lib/ops/impact";

// 管理画面の確認に出す変更内容と影響。利用許可と稼働状態を混同しない書き方になっていること。

function feature(over: Partial<FeatureChangeInput>): FeatureChangeInput {
  return {
    key: "reservation_notifications",
    label: "予約通知",
    hasRuntime: true,
    beforeOverride: "inherit",
    afterOverride: "deny",
    before: { allowed: true, reason: "plan_default" },
    after: { allowed: false, reason: "override_deny" },
    holdOpen: false,
    runtimeStarted: true,
    ...over,
  };
}

describe("予約通知", () => {
  it("稼働中に利用不可にすると、新しい送信を始めないこと・送信開始済みは続くこと・自動で再開しないことを出す", () => {
    const [s] = describeChanges({ planBefore: "salonpack", planAfter: "salonpack", features: [feature({})] });
    expect(s.revokes).toBe(true);
    expect(s.title).toBe("予約通知: 利用中 → 停止");
    const text = s.details.join("\n");
    expect(text).toContain("新しい予約メールの確認と通知の送信を始めません");
    expect(text).toContain("送信を開始済みの通知は完了まで続きます");
    expect(text).toContain("自動では再開せず");
    expect(text).toContain("残ります");
  });

  it("開始前の店舗では、停止の記録を作らないと出す", () => {
    const [s] = describeChanges({ planBefore: "salonpack", planAfter: "salonpack", features: [feature({ runtimeStarted: false })] });
    expect(s.details.join("\n")).toContain("停止の記録は作りません");
  });

  it("再び許可しても、権限による停止が開いていれば送信は再開しないと出す", () => {
    const [s] = describeChanges({
      planBefore: "salonpack",
      planAfter: "salonpack",
      features: [feature({ beforeOverride: "deny", afterOverride: "inherit", before: { allowed: false, reason: "override_deny" }, after: { allowed: true, reason: "plan_default" }, holdOpen: true })],
    });
    expect(s.revokes).toBe(false);
    expect(s.details.join("\n")).toContain("送信は再開しません");
  });

  it("許可しただけでは連携・通知を始めないと出す(開始前)", () => {
    const [s] = describeChanges({
      planBefore: "reviews",
      planAfter: "salonpack",
      features: [feature({ beforeOverride: "inherit", afterOverride: "inherit", before: { allowed: false, reason: "not_in_plan" }, after: { allowed: true, reason: "plan_default" }, runtimeStarted: false })],
    }).slice(1);
    expect(s.title).toBe("予約通知: 使えない → 利用中");
    expect(s.details.join("\n")).toContain("この保存だけでは連携や通知を始めません");
  });
});

describe("口コミ・プランの変更", () => {
  it("口コミを止めると、お客様用ページ・生成も止めること、理由を出さないこと、データは消さないことを出す", () => {
    const [s] = describeChanges({
      planBefore: "reviews",
      planAfter: "reviews",
      features: [feature({ key: "reviews", label: "口コミ", hasRuntime: false, runtimeStarted: false })],
    });
    const text = s.details.join("\n");
    expect(text).toContain("お客様用ページ、口コミ文章の生成を止めます");
    expect(text).toContain("現在ご利用いただけません");
    expect(text).toContain("削除しません");
  });

  it("プランを変えると、使えなくなる機能の利用中/停止の設定は残り、戻すとそのままだと出す", () => {
    const summaries = describeChanges({
      planBefore: "salonpack",
      planAfter: "reviews",
      features: [
        feature({ key: "blog", label: "ブログ", hasRuntime: false, beforeOverride: "allow", afterOverride: "allow", before: { allowed: true, reason: "override_allow" }, after: { allowed: false, reason: "not_in_plan" } }),
      ],
    });
    expect(summaries[0].title).toBe("契約プラン: SalonPack → 口コミプラン");
    expect(summaries[0].details.join("\n")).toContain("ブログは口コミプランでは使えません。SalonPackに戻した場合は「利用中」のままです。");
    expect(summaries[0].details.join("\n")).not.toMatch(/標準|個別/);
    expect(summaries[1]).toMatchObject({ title: "ブログ: 利用中 → 使えない", revokes: true });
    expect(summaries[1].details[0]).toBe("理由: この契約プランでは使えません。");
  });

  it("変更が無ければ何も出さない", () => {
    expect(describeChanges({ planBefore: "salonpack", planAfter: "salonpack", features: [feature({ afterOverride: "inherit", after: { allowed: true, reason: "plan_default" } })] })).toEqual([]);
  });
});

describe("使えるかどうかが変わらない設定の変更", () => {
  it("使えるかどうかが変わらない変更は、そう書く", () => {
    const [s] = describeChanges({
      planBefore: "reviews",
      planAfter: "reviews",
      features: [feature({ key: "blog", label: "ブログ", hasRuntime: false, beforeOverride: "deny", afterOverride: "inherit", before: { allowed: false, reason: "not_in_plan" }, after: { allowed: false, reason: "not_in_plan" } })],
    });
    expect(s).toMatchObject({ title: "ブログ: 設定を変更", revokes: false, details: ["使えるかどうかは変わりません。"] });
  });
});
