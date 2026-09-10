import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

// text-base (16px) is deliberate, not text-sm: below 16px, iOS Safari
// auto-zooms the page on focus (see globals.css's global input rule, which
// this also satisfies even where a caller forgets to add it explicitly).
const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full rounded-lg border border-greige bg-white px-3 py-2.5 text-base text-ink placeholder:text-ink-muted focus:border-sage focus:outline-none focus-visible:ring-2 focus-visible:ring-sage/40",
          className,
        )}
        {...props}
      />
    );
  },
);

export default Input;
