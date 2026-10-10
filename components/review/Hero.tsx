export default function Hero({ salonName }: { salonName: string }) {
  return (
    <div className="pt-4 pb-4 text-center">
      <p className="text-sm tracking-wide text-earth">{salonName}</p>
      <h1 className="mt-1 text-xl font-semibold text-stone-800">お客様アンケート</h1>
    </div>
  );
}
