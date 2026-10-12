import { describe, expect, it } from "vitest";
import { isSwitchOn, overrideForSwitch, switchLabel } from "@/lib/ops/toggle";
import type { OverrideMode } from "@/lib/features/entitlements";

// 管理画面のスイッチ(利用中/停止)と、保存する個別設定の対応。

describe("プランの標準で使える機能(今の3機能)", () => {
  it("利用中 = 標準どおり、停止 = 個別に利用不可", () => {
    expect(overrideForSwitch(false, true, "inherit")).toBe("deny");
    expect(overrideForSwitch(true, true, "deny")).toBe("inherit");
    expect(isSwitchOn("inherit", true)).toBe(true);
    expect(isSwitchOn("deny", true)).toBe(false);
  });

  it("押して元に戻しただけなら、保存済みの値に戻る(変更を作らない)", () => {
    for (const saved of ["inherit", "allow", "deny"] as OverrideMode[]) {
      // 下書きの値に関係なく、保存済みと同じ側に戻したら保存済みの値になる
      expect(overrideForSwitch(isSwitchOn(saved, true), true, saved)).toBe(saved);
    }
    // 以前の「個別に許可」(標準と同じ側)を停止にして戻すと、元の値に戻る
    const off = overrideForSwitch(false, true, "allow");
    expect(off).toBe("deny");
    expect(overrideForSwitch(true, true, "allow")).toBe("allow");
  });
});

describe("プランの標準では使えない機能(将来)", () => {
  it("利用中 = 個別に許可、停止 = 標準どおり", () => {
    expect(overrideForSwitch(true, false, "inherit")).toBe("allow");
    expect(overrideForSwitch(false, false, "allow")).toBe("inherit");
    expect(isSwitchOn("inherit", false)).toBe(false);
  });
});

describe("変更履歴の表示(スイッチと同じ言葉)", () => {
  it("標準で使える機能: 標準どおり・個別に許可は「利用中」、個別に利用不可は「停止」", () => {
    expect(switchLabel("inherit", true)).toBe("利用中");
    expect(switchLabel("allow", true)).toBe("利用中");
    expect(switchLabel("deny", true)).toBe("停止");
  });

  it("標準では使えない機能(将来): 個別に許可だけ「利用中」", () => {
    expect(switchLabel("inherit", false)).toBe("停止");
    expect(switchLabel("allow", false)).toBe("利用中");
    expect(switchLabel("deny", false)).toBe("停止");
  });
});
