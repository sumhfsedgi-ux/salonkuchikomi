"use client";

import { useState } from "react";
import type { OwnerSalon } from "@/lib/types";
import { updateSalonAction } from "@/app/admin/(authed)/settings/actions";

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
        <label htmlFor="name" className="mb-1 block text-sm font-medium text-stone-700">
          店舗名
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full rounded-lg border border-greige px-3 py-2.5 text-sm text-stone-800 focus:border-sage focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="business_type" className="mb-1 block text-sm font-medium text-stone-700">
          業種（任意）
        </label>
        <p className="mb-1 text-xs text-stone-500">
          口コミ作成AIが回答内容を正しく理解するための参考情報として使用します。
        </p>
        <input
          id="business_type"
          value={businessType}
          onChange={(e) => setBusinessType(e.target.value)}
          placeholder="例：ヘアサロン、エステサロン、整体院"
          className="w-full rounded-lg border border-greige px-3 py-2.5 text-sm text-stone-800 focus:border-sage focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="google_review_url" className="mb-1 block text-sm font-medium text-stone-700">
          Google口コミ投稿URL
        </label>
        <p className="mb-1 text-xs text-stone-500">
          Googleビジネスプロフィール（Googleマップの管理画面）の「クチコミを増やす」機能から取得できるリンクを貼り付けてください。
        </p>
        <input
          id="google_review_url"
          type="url"
          value={googleReviewUrl}
          onChange={(e) => setGoogleReviewUrl(e.target.value)}
          placeholder="https://..."
          className="w-full rounded-lg border border-greige px-3 py-2.5 text-sm text-stone-800 focus:border-sage focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium text-stone-700">
          店舗説明（任意）
        </label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-lg border border-greige px-3 py-2.5 text-sm text-stone-800 focus:border-sage focus:outline-none"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg bg-sage/10 p-3 text-sm text-sage-dark">
          保存しました。
        </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-lg bg-sage py-2.5 text-sm font-medium text-white transition hover:bg-sage-dark disabled:opacity-50 sm:w-auto sm:px-6"
      >
        {saving ? "保存しています..." : "保存する"}
      </button>
    </form>
  );
}
