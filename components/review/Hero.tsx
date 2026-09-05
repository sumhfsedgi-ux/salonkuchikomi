export default function Hero({ salonName }: { salonName: string }) {
  return (
    <div className="pt-6 pb-4 text-center">
      <p className="text-sm tracking-wide text-earth">{salonName}</p>
      <h1 className="mt-2 text-2xl font-semibold text-stone-800">
        かんたん30秒
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">
        <span className="block text-balance">
          アンケート内容をもとに、口コミ文章の作成をお手伝いします！
        </span>
      </p>
    </div>
  );
}
