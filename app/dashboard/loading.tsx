import Skeleton from "@/components/ui/Skeleton";

// Covers each page's own data fetching once the shared layout (which reads
// the session and resolves the current salon) has finished rendering — see
// node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md
// ("With loading.js"): a layout that reads cookies()/uncached data still
// blocks navigation itself, this only streams in what each page adds on top.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40 w-full max-w-xl rounded-2xl" />
    </div>
  );
}
