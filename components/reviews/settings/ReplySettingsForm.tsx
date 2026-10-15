"use client";

import { useId, useState } from "react";
import Card from "@/components/ui/Card";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Textarea from "@/components/ui/Textarea";
import PillSelect from "@/components/ui/PillSelect";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import LeaveGuard from "@/components/ui/LeaveGuard";
import {
  REPLY_LENGTH_OPTIONS,
  REPLY_TEXT_LIMITS,
  REPLY_TONE_OPTIONS,
  REVISIT_LINE_OPTIONS,
  sameReplySettings,
  STORE_NAME_OPTIONS,
  type ReplySettings,
} from "@/lib/replyGeneration/settings";
import type { SaveReplySettingsResult } from "@/app/dashboard/reviews/settings/actions";

// AI返信の設定(docs/plans/google-reviews-inbox-plan.md §9-4)。基本の4項目は常に表示し、
// 署名・連絡先の案内・追加の指示は「詳しく設定する」で開く(blog の設定画面と同じ形)。
// 自由入力があるので、変更のたびではなく [保存する] でまとめて保存する。

interface Props {
  initialSettings: ReplySettings;
  /** 保存できる状態か(0013 が未適用などで保存できないときは false)。 */
  storageAvailable: boolean;
  save: (settings: ReplySettings) => Promise<SaveReplySettingsResult>;
}

export default function ReplySettingsForm({ initialSettings, storageAvailable, save }: Props) {
  const signatureId = useId();
  const contactId = useId();
  const extraId = useId();

  const [settings, setSettings] = useState<ReplySettings>(initialSettings);
  const [saved, setSaved] = useState<ReplySettings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(
    () => Boolean(initialSettings.signature || initialSettings.contactNote || initialSettings.extraInstructions),
  );

  const dirty = !sameReplySettings(settings, saved);

  function update<K extends keyof ReplySettings>(key: K, value: ReplySettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setStatus(null);
  }

  async function handleSave() {
    if (saving || !storageAvailable) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await save(settings);
      if (result.ok) {
        setSettings(result.settings);
        setSaved(result.settings);
        setStatus({ type: "success", message: "保存しました。" });
      } else {
        setStatus({ type: "error", message: result.error });
      }
    } catch {
      setStatus({ type: "error", message: "保存できませんでした。もう一度お試しください。" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <LeaveGuard
        when={dirty && storageAvailable}
        message="AI返信の設定に、保存していない変更があります。移動すると、変更は保存されません。"
      />

      {!storageAvailable && (
        <Alert variant="warning">
          返信設定の保存は準備中です。いまは標準の設定で返信案を作ります。
        </Alert>
      )}

      <Card className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-ink">返信の基本</h2>

        <div>
          <Label>返信のトーン</Label>
          <PillSelect options={REPLY_TONE_OPTIONS} value={settings.tone} onChange={(v) => update("tone", v)} />
        </div>

        <div>
          <Label>返信の長さ</Label>
          <PillSelect options={REPLY_LENGTH_OPTIONS} value={settings.length} onChange={(v) => update("length", v)} />
        </div>

        <div>
          <Label>店舗名を入れる</Label>
          <PillSelect
            options={STORE_NAME_OPTIONS}
            value={settings.includeStoreName ? "on" : "off"}
            onChange={(v) => update("includeStoreName", v === "on")}
          />
        </div>

        <div>
          <Label>再来店への一言</Label>
          <PillSelect
            options={REVISIT_LINE_OPTIONS}
            value={settings.revisitLine}
            onChange={(v) => update("revisitLine", v)}
          />
          <p className="mt-1 text-xs text-ink-muted">
            ★1〜2や、トラブルにつながる内容の口コミへの返信には、設定にかかわらず入れません。
          </p>
        </div>

        {!showAdvanced ? (
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="self-start rounded-lg text-sm text-ink-muted transition hover:text-sage-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50"
          >
            詳しく設定する（任意）
          </button>
        ) : (
          <>
            <div>
              <Label htmlFor={signatureId}>結びの署名（任意）</Label>
              <Input
                id={signatureId}
                value={settings.signature}
                maxLength={REPLY_TEXT_LIMITS.signature}
                placeholder="例：スタッフ一同"
                onChange={(e) => update("signature", e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-muted">返信の最後の行に、そのまま付け足します。</p>
            </div>

            <div>
              <Label htmlFor={contactId}>慎重に返信するときの連絡先の案内（任意）</Label>
              <Input
                id={contactId}
                value={settings.contactNote}
                maxLength={REPLY_TEXT_LIMITS.contactNote}
                placeholder="例：お手数ですが、店舗までご連絡ください。"
                onChange={(e) => update("contactNote", e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-muted">
                ★1〜2や、トラブルにつながる内容の口コミへの返信の最後に付け足します。電話番号やURLは、Googleで公開できないことがあるため入れないでください。
              </p>
            </div>

            <div>
              <Label htmlFor={extraId}>追加の指示（任意）</Label>
              <Textarea
                id={extraId}
                value={settings.extraInstructions}
                maxLength={REPLY_TEXT_LIMITS.extraInstructions}
                rows={3}
                placeholder="例：「ありがとうございます」を最初に入れてください"
                onChange={(e) => update("extraInstructions", e.target.value)}
              />
              <p className="mt-1 flex justify-between gap-2 text-xs text-ink-muted">
                <span>返信の安全のための決まり（反論・補償の約束をしない など）より優先はされません。</span>
                <span className="shrink-0">
                  {[...settings.extraInstructions].length}/{REPLY_TEXT_LIMITS.extraInstructions}
                </span>
              </p>
            </div>
          </>
        )}
      </Card>

      <p className="text-sm text-ink-muted">
        設定は次に作る返信案から使われます。作成中の返信案や、Googleに公開済みの返信は変わりません。
      </p>

      {status?.type === "error" && <Alert variant="error">{status.message}</Alert>}
      {status?.type === "success" && !dirty && <Alert variant="success">{status.message}</Alert>}

      <Button
        type="button"
        onClick={handleSave}
        disabled={saving || !storageAvailable || !dirty}
        fullWidth
        className="sm:w-auto sm:px-6"
      >
        {saving ? "保存しています…" : "保存する"}
      </Button>
    </div>
  );
}
