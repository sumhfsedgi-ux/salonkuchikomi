// Shown only for the first-ever generation (no review exists yet). A
// regeneration with an existing review keeps that review visible instead --
// see ReviewFlow.tsx.
export default function ResultSkeleton() {
  return (
    <div className="card flex flex-col items-center gap-4 py-10 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-greige border-t-sage" />
      <div className="w-full space-y-2">
        <div className="mx-auto h-3 w-5/6 animate-pulse rounded-full bg-beige" />
        <div className="mx-auto h-3 w-full animate-pulse rounded-full bg-beige" />
        <div className="mx-auto h-3 w-4/6 animate-pulse rounded-full bg-beige" />
      </div>
      <p className="text-sm text-stone-500">口コミを作成しています…</p>
    </div>
  );
}
