import StepIndicator, { type ReviewStep } from "@/components/review/StepIndicator";

// 画面の一番上に横いっぱいの白い帯を置き、店名(主役)・「お客様アンケート」(添え字)・ステップをまとめる。
export default function ReviewHeader({ salonName, step }: { salonName: string; step: ReviewStep }) {
  return (
    <header className="border-b border-greige/60 bg-white">
      <div className="mx-auto w-full max-w-[500px] px-4 pt-5 pb-4 text-center">
        <p className="text-lg font-medium tracking-wide text-stone-700">{salonName}</p>
        <p className="mt-1 text-[11px] font-medium tracking-[0.25em] text-earth">お客様アンケート</p>
        <div className="mt-4 border-t border-greige/50 pt-4">
          <StepIndicator current={step} />
        </div>
      </div>
    </header>
  );
}
