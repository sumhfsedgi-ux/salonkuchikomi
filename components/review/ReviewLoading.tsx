export default function ReviewLoading() {
  return (
    <div className="py-6">
      <div className="card flex flex-col items-center gap-4 py-16 text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-greige border-t-sage" />
        <div>
          <p className="text-base font-medium text-stone-800">
            口コミを作成しています
          </p>
          <p className="mt-2 text-sm leading-relaxed text-stone-500">
            回答いただいた内容をもとに
            <br />
            自然な文章にまとめています。
          </p>
        </div>
      </div>
    </div>
  );
}
