import Link from "next/link";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import type { OwnerSalon } from "@/lib/types";

export default function SalonDashboard({
  salon,
  customerUrl,
}: {
  salon: OwnerSalon;
  customerUrl: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">{salon.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          お客様への口コミ作成ページと、店舗の設定をここから管理できます。
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/admin/survey"
          className="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-slate-300 hover:shadow-sm"
        >
          <p className="font-medium text-slate-800">口コミアンケート設定</p>
          <p className="mt-1 text-sm text-slate-500">
            お客様に聞く質問や選択肢を編集します。
          </p>
        </Link>

        <Link
          href="/admin/settings"
          className="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-slate-300 hover:shadow-sm"
        >
          <p className="font-medium text-slate-800">店舗設定</p>
          <p className="mt-1 text-sm text-slate-500">
            店舗名・Google口コミURL・店舗説明を編集します。
          </p>
        </Link>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <p className="font-medium text-slate-800">お客様用URL</p>
        <p className="mt-1 text-sm text-slate-500">
          施術後のお客様へLINEやDMでこちらのURLをお送りください。
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
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
