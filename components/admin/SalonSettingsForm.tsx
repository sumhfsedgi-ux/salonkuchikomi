"use client";

import { useState } from "react";
import type { OwnerSalon } from "@/lib/types";
import { updateSalonAction } from "@/app/admin/(authed)/settings/actions";

export default function SalonSettingsForm({ salon }: { salon: OwnerSalon }) {
  const [name, setName] = useState(salon.name);
  const [slug, setSlug] = useState(salon.slug);
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
    formData.set("slug", slug);
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
        <label htmlFor="name" className="mb-1 block text-sm font-medium text-slate-700">
          店舗名
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="slug" className="mb-1 block text-sm font-medium text-slate-700">
          ページURL
        </label>
        <p className="mb-1 text-xs text-slate-500">
          お客様用URLの一部になります。半角英数字とハイフンのみ使用できます。
        </p>
        <input
          id="slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="google_review_url" className="mb-1 block text-sm font-medium text-slate-700">
          Google口コミ投稿URL
        </label>
        <input
          id="google_review_url"
          type="url"
          value={googleReviewUrl}
          onChange={(e) => setGoogleReviewUrl(e.target.value)}
          placeholder="https://..."
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium text-slate-700">
          店舗説明（任意）
        </label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          保存しました。
        </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-lg bg-slate-800 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900 disabled:opacity-50 sm:w-auto sm:px-6"
      >
        {saving ? "保存しています..." : "保存する"}
      </button>
    </form>
  );
}
