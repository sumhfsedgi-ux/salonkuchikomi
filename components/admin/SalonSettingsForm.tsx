"use client";

import { useState } from "react";
import type { OwnerSalon } from "@/lib/types";
import { updateSalonAction } from "@/app/dashboard/settings/actions";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Textarea from "@/components/ui/Textarea";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

export default function SalonSettingsForm({ salon }: { salon: OwnerSalon }) {
  const [name, setName] = useState(salon.name);
  const [businessType, setBusinessType] = useState(salon.businessType ?? "");
  const [googleReviewUrl, setGoogleReviewUrl] = useState(salon.googleReviewUrl ?? "");
  const [description, setDescription] = useState(salon.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    const formData = new FormData();
    formData.set("name", name);
    formData.set("business_type", businessType);
    formData.set("google_review_url", googleReviewUrl);
    formData.set("description", description);

    const result = await updateSalonAction(formData);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSuccess(true);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div>
        <Label htmlFor="name">店舗名</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div>
        <Label htmlFor="business_type">業種（任意）</Label>
        <p className="mb-1 text-xs text-ink-muted">
          口コミ作成AIが回答内容を正しく理解するための参考情報として使用します。
        </p>
        <Input
          id="business_type"
          value={businessType}
          onChange={(e) => setBusinessType(e.target.value)}
          placeholder="例：ヘアサロン、エステサロン、整体院"
        />
      </div>

      <div>
        <Label htmlFor="google_review_url">Google口コミ投稿URL</Label>
        <p className="mb-1 text-xs text-ink-muted">
          Googleビジネスプロフィール（Googleマップの管理画面）の「クチコミを増やす」機能から取得できるリンクを貼り付けてください。
        </p>
        <Input
          id="google_review_url"
          type="url"
          value={googleReviewUrl}
          onChange={(e) => setGoogleReviewUrl(e.target.value)}
          placeholder="https://..."
        />
      </div>

      <div>
        <Label htmlFor="description">店舗説明（任意）</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {success && <Alert variant="success">保存しました。</Alert>}

      <Button type="submit" disabled={saving} fullWidth className="sm:w-auto sm:px-6">
        {saving ? "保存しています..." : "保存する"}
      </Button>
    </form>
  );
}
