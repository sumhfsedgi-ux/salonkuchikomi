// お客様用ページ: 運営が口コミの利用を止めている店舗に出す。理由(契約・運営内部の事情)は書かない。
export default function ReviewUnavailable() {
  return (
    <div className="mx-auto flex w-full max-w-[500px] flex-1 flex-col items-center justify-center px-4 text-center">
      <p className="text-lg font-semibold text-stone-800">現在ご利用いただけません</p>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">恐れ入りますが、時間をおいてお試しください。</p>
    </div>
  );
}
