"use client";

import PillSelect from "@/components/ui/PillSelect";
import Input from "@/components/ui/Input";
import type { ThemeInput } from "@/lib/blog/types";

type Mode = "omakase" | "specified";

interface Props {
  value: ThemeInput;
  onChange: (value: ThemeInput) => void;
}

export default function ThemeChooser({ value, onChange }: Props) {
  return (
    <div>
      <PillSelect<Mode>
        options={[
          { value: "omakase", label: "おまかせ" },
          { value: "specified", label: "テーマを指定する" },
        ]}
        value={value.mode}
        onChange={(next) => {
          if (next === "omakase") onChange({ mode: "omakase" });
          else onChange({ mode: "specified", text: value.mode === "specified" ? value.text : "" });
        }}
      />
      {value.mode === "specified" && (
        <Input
          type="text"
          maxLength={60}
          placeholder="例：毛穴について"
          value={value.text}
          onChange={(e) => onChange({ mode: "specified", text: e.target.value })}
          className="mt-3"
        />
      )}
    </div>
  );
}
