"use client";

import { useState } from "react";
import PillSelect from "@/components/ui/PillSelect";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import { LENGTH_PRESETS, CUSTOM_LENGTH_BOUNDS } from "@/lib/blog/config/blogRules";
import type { LengthInput } from "@/lib/blog/types";
import type { LengthType } from "@/lib/blog/config/blogRules";

interface Props {
  value: LengthInput;
  onChange: (value: LengthInput) => void;
}

const PRESET_KEYS = ["short", "standard", "long"] as const satisfies readonly Exclude<
  LengthType,
  "custom"
>[];

const PRESET_OPTIONS = PRESET_KEYS.map((key) => ({
  value: key,
  label: LENGTH_PRESETS[key].label,
}));

const DEFAULT_CUSTOM_TARGET = 650;

export default function LengthControl({ value, onChange }: Props) {
  const [showCustom, setShowCustom] = useState(value.type === "custom");

  return (
    <div>
      <PillSelect
        options={PRESET_OPTIONS}
        value={value.type === "custom" ? undefined : value.type}
        onChange={(next) => {
          setShowCustom(false);
          onChange({ type: next });
        }}
      />

      {!showCustom ? (
        <button
          type="button"
          className="mt-2 text-sm text-ink-muted transition hover:text-sage-dark"
          onClick={() => {
            setShowCustom(true);
            onChange({
              type: "custom",
              target: value.type === "custom" ? value.target : DEFAULT_CUSTOM_TARGET,
            });
          }}
        >
          細かく指定する
        </button>
      ) : (
        <div className="mt-3">
          <Label htmlFor="custom-length">
            文字数の目安（{CUSTOM_LENGTH_BOUNDS.min}〜{CUSTOM_LENGTH_BOUNDS.max}字）
          </Label>
          <Input
            id="custom-length"
            type="number"
            inputMode="numeric"
            min={CUSTOM_LENGTH_BOUNDS.min}
            max={CUSTOM_LENGTH_BOUNDS.max}
            step={50}
            value={value.type === "custom" ? value.target : DEFAULT_CUSTOM_TARGET}
            onChange={(e) => {
              const raw = Number(e.target.value);
              onChange({ type: "custom", target: Number.isFinite(raw) ? raw : DEFAULT_CUSTOM_TARGET });
            }}
            onBlur={(e) => {
              const raw = Number(e.target.value);
              const clamped = Math.min(
                Math.max(Number.isFinite(raw) ? raw : DEFAULT_CUSTOM_TARGET, CUSTOM_LENGTH_BOUNDS.min),
                CUSTOM_LENGTH_BOUNDS.max
              );
              onChange({ type: "custom", target: clamped });
            }}
          />
          <button
            type="button"
            className="mt-2 text-sm text-ink-muted transition hover:text-sage-dark"
            onClick={() => {
              setShowCustom(false);
              onChange({ type: "standard" });
            }}
          >
            プリセットに戻す
          </button>
        </div>
      )}
    </div>
  );
}
