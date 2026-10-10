"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import { updateFeatureSelectionAction } from "@/app/dashboard/features/actions";
import type { FeatureOption } from "@/lib/features/viewModel";

interface Props {
  options: FeatureOption[];
  submitLabel: string;
  /** 保存後の移動先(省略時はその場で再読み込み)。 */
  afterSave?: string;
}

// 契約上使える機能の一覧から、使う機能を複数選ぶ(固定の選択肢にしない)。準備中の機能は選べない。
export default function FeatureSelectionForm({ options, submitLabel, afterSave }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set(options.filter((o) => o.selected).map((o) => o.key)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggle(key: string, checked: boolean) {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const result = await updateFeatureSelectionAction([...selected]);
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "保存に失敗しました。");
      return;
    }
    setSaved(true);
    if (afterSave) router.push(afterSave);
    else router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {options.map((option) => (
          <li key={option.key}>
            <label className={`flex items-start gap-3 rounded-lg border border-border p-3 ${option.comingSoon ? "opacity-60" : ""}`}>
              <input
                type="checkbox"
                className="mt-1 h-5 w-5 shrink-0 accent-sage-dark"
                checked={selected.has(option.key)}
                disabled={option.comingSoon}
                onChange={(e) => toggle(option.key, e.target.checked)}
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium text-ink">
                  {option.label}
                  {option.comingSoon && <span className="ml-2 text-xs text-ink-muted">準備中</span>}
                </span>
                <span className="text-xs text-ink-muted">{option.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-muted">あとからいつでも変更できます。選ばなかった機能のデータや契約は変わりません。</p>
      {error && <Alert variant="error">{error}</Alert>}
      {saved && !afterSave && <Alert variant="success">保存しました。</Alert>}
      <Button type="submit" disabled={saving} className="w-fit">
        {saving ? "保存しています..." : submitLabel}
      </Button>
    </form>
  );
}
