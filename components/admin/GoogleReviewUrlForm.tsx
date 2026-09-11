"use client";

import { useState } from "react";
import { updateGoogleReviewUrlAction } from "@/app/dashboard/reviews/actions";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

export default function GoogleReviewUrlForm({ initialUrl }: { initialUrl: string | null }) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    const formData = new FormData();
    formData.set("google_review_url", url);

    const result = await updateGoogleReviewUrlAction(formData);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSuccess(true);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div>
        <Label htmlFor="google_review_url">Google口コミ投稿URL</Label>
        <p className="mb-1 text-xs text-ink-muted">
          口コミ作成後に移動する、Googleの投稿ページURLです。
        </p>
        <Input
          id="google_review_url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
        />
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {success && <Alert variant="success">保存しました。</Alert>}

      <Button type="submit" disabled={saving} className="self-start px-6">
        {saving ? "保存しています..." : "保存する"}
      </Button>
    </form>
  );
}
