"use client";

import { useState } from "react";
import PillSelect from "@/components/ui/PillSelect";
import Card from "@/components/ui/Card";
import Label from "@/components/ui/Label";
import Textarea from "@/components/ui/Textarea";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import TagListInput from "@/components/blog/settings/TagListInput";
import { saveSalonSettingsAction } from "@/app/dashboard/blog/settings/actions";
import {
  TONE_OPTIONS,
  EMOJI_LEVELS,
  TARGET_CUSTOMER_PRESETS,
  TAG_LIST_LIMITS,
  SHORT_TEXT_LIMITS,
  FIELD_EXAMPLES,
  type SalonSettings,
} from "@/lib/blog/config/salon";
import { cn } from "@/lib/cn";

interface Props {
  initialSettings: SalonSettings;
}

export default function SalonSettingsForm({ initialSettings }: Props) {
  const [settings, setSettings] = useState<SalonSettings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(
    () => Boolean(initialSettings.salonTraits || initialSettings.avoidExpressions)
  );

  const examples = FIELD_EXAMPLES;

  function update<K extends keyof SalonSettings>(key: K, value: SalonSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setStatus(null);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await saveSalonSettingsAction(settings);
      setStatus(
        result.ok
          ? { type: "success", message: "保存しました。" }
          : { type: "error", message: result.error ?? "保存に失敗しました。" }
      );
    } catch (err) {
      console.error(err);
      setStatus({ type: "error", message: "保存に失敗しました。もう一度お試しください。" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-ink">メニュー・お客様</h2>
        <div>
          <Label>主なメニュー</Label>
          <TagListInput
            value={settings.mainMenu}
            onChange={(v) => update("mainMenu", v)}
            placeholder={`例：${examples.mainMenu}`}
          />
        </div>

        <div>
          <Label>得意な施術・サービス</Label>
          <TagListInput
            value={settings.specialties}
            onChange={(v) => update("specialties", v)}
            placeholder={`例：${examples.specialties}`}
          />
        </div>

        <div>
          <Label>想定するお客様（複数選択可）</Label>
          <div className="mb-2 flex flex-wrap gap-2">
            {TARGET_CUSTOMER_PRESETS.map((preset) => {
              const selected = settings.targetCustomers.includes(preset);
              const full = settings.targetCustomers.length >= TAG_LIST_LIMITS.maxItems;
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={selected || full}
                  onClick={() => update("targetCustomers", [...settings.targetCustomers, preset])}
                  className={cn(
                    "min-h-9 rounded-full border px-3 text-xs transition disabled:opacity-50",
                    selected
                      ? "border-sage bg-sage-soft text-sage-dark"
                      : "border-border bg-white text-ink-muted",
                  )}
                >
                  {preset}
                </button>
              );
            })}
          </div>
          <TagListInput
            value={settings.targetCustomers}
            onChange={(v) => update("targetCustomers", v)}
            placeholder="自由入力もできます"
          />
        </div>

        <div>
          <Label>よくあるお客様の悩み</Label>
          <TagListInput
            value={settings.commonConcerns}
            onChange={(v) => update("commonConcerns", v)}
            placeholder={`例：${examples.commonConcerns}`}
          />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-ink">文章の雰囲気</h2>
        <div>
          <Label>文章の雰囲気</Label>
          <PillSelect
            options={TONE_OPTIONS.map((t) => ({ value: t, label: t }))}
            value={settings.tone}
            onChange={(v) => update("tone", v)}
          />
        </div>

        <div>
          <Label>絵文字の使用量</Label>
          <PillSelect
            options={EMOJI_LEVELS.map((t) => ({ value: t, label: t }))}
            value={settings.emojiLevel}
            onChange={(v) => update("emojiLevel", v)}
          />
        </div>

        {!showAdvanced ? (
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="self-start text-sm text-ink-muted transition hover:text-sage-dark"
          >
            詳しく設定する（任意）
          </button>
        ) : (
          <>
            <div>
              <Label htmlFor="blog-salon-traits">サロンの特徴・強み（任意）</Label>
              <Textarea
                id="blog-salon-traits"
                value={settings.salonTraits}
                maxLength={SHORT_TEXT_LIMITS.salonTraits}
                rows={2}
                onChange={(e) => update("salonTraits", e.target.value)}
              />
              <p className="mt-1 text-right text-xs text-ink-muted">
                {settings.salonTraits.length}/{SHORT_TEXT_LIMITS.salonTraits}
              </p>
            </div>

            <div>
              <Label htmlFor="blog-avoid-expressions">避けたい表現（任意）</Label>
              <Textarea
                id="blog-avoid-expressions"
                value={settings.avoidExpressions ?? ""}
                maxLength={SHORT_TEXT_LIMITS.avoidExpressions}
                rows={2}
                onChange={(e) => update("avoidExpressions", e.target.value)}
              />
            </div>
          </>
        )}
      </Card>

      {status?.type === "error" && <Alert variant="error">{status.message}</Alert>}
      {status?.type === "success" && <Alert variant="success">{status.message}</Alert>}

      <Button type="button" onClick={handleSave} disabled={saving} fullWidth className="sm:w-auto sm:px-6">
        {saving ? "保存しています…" : "保存する"}
      </Button>
    </div>
  );
}
