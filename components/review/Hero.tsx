// STEP 1 の上に出す説明。回答はまだ保存していない(保存は後の計画。サービス改善の一文はご本人の判断で先に入れている)。
export default function Hero({ salonName }: { salonName: string }) {
  return (
    <div className="pt-4 pb-4 text-center">
      <p className="text-sm tracking-wide text-earth">{salonName}</p>
      <h1 className="mt-1 text-xl font-semibold text-stone-800">お客様アンケート</h1>
      <div className="card mt-4 space-y-2 text-left text-sm leading-relaxed text-stone-600">
        <p>このアンケートは当店をご利用いただいた方を対象としています。</p>
        <p>アンケートに回答することで得られるデータは、当店のサービス改善に活用させていただきます。</p>
      </div>
    </div>
  );
}
