export default function SalonNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[500px] flex-1 flex-col items-center justify-center px-4 text-center">
      <p className="text-lg font-semibold text-stone-800">
        店舗が見つかりませんでした
      </p>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">
        URLをご確認のうえ、もう一度お試しください。
      </p>
    </div>
  );
}
