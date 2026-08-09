import Link from "next/link";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import type { OwnerSalon } from "@/lib/types";

export default function SalonDashboard({
  salon,
  customerUrl,
  justOnboarded = false,
}: {
  salon: OwnerSalon;
  customerUrl: string;
  justOnboarded?: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      {justOnboarded && (
        <div className="rounded-2xl bg-sage/10 p-4 text-sm text-sage-dark">
          設定が完了しました。お客様用URLをお使いください。
        </div>
      )}
      <div>
        <h1 className="text-xl font-semibold text-stone-800">{salon.name}</h1>
        <p className="mt-1 text-sm text-stone-500">
          お客様への口コミ作成ページと、店舗の設定をここから管理できます。
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/admin/survey"
          className="rounded-2xl bg-white p-5 shadow-sm transition hover:shadow-md"
        >
          <p className="font-medium text-stone-800">お客様への質問</p>
          <p className="mt-1 text-sm text-stone-500">
            アンケートの質問や選択肢を編集します。
          </p>
        </Link>

        <Link
          href="/admin/settings"
          className="rounded-2xl bg-white p-5 shadow-sm transition hover:shadow-md"
        >
          <p className="font-medium text-stone-800">店舗設定</p>
          <p className="mt-1 text-sm text-stone-500">
            店舗名・Google口コミURL・店舗説明を編集します。
          </p>
        </Link>
      </div>

      <div className="rounded-2xl bg-white p-5 shadow-sm">
        <p className="font-medium text-stone-800">お客様用URL</p>
        <p className="mt-1 text-sm text-stone-500">
          施術後のお客様へLINEやDMでこちらのURLをお送りください。
        </p>
        <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 truncate rounded-lg bg-ivory px-3 py-2.5 text-sm text-stone-700">
            {customerUrl}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CopyUrlButton url={customerUrl} />
          </div>
        </div>
      </div>
    </div>
  );
}
