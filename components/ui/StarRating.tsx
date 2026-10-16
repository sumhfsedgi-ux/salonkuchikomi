import { cn } from "@/lib/cn";
import { StarIcon } from "@/components/ui/icons";

// ★の表示(docs/plans/google-reviews-inbox-plan.md §8-7)。塗りと線の形で区別し、色(earth)だけに頼らない。
// 読み上げ用に「5段階中4」を付ける。value が無い(★の情報が無い)ときは何も出さない。
interface StarRatingProps {
  value: number | null;
  size?: "sm" | "md";
  className?: string;
}

export default function StarRating({ value, size = "sm", className }: StarRatingProps) {
  if (value === null) return null;
  const rounded = Math.round(value);
  const dimension = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-earth", className)} role="img" aria-label={`5段階中${value}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon key={n} filled={n <= rounded} className={dimension} aria-hidden="true" />
      ))}
    </span>
  );
}
