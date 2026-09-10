import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full resize-none rounded-lg border border-greige bg-white px-3 py-2.5 text-base text-ink placeholder:text-ink-muted focus:border-sage focus:outline-none focus-visible:ring-2 focus-visible:ring-sage/40",
          className,
        )}
        {...props}
      />
    );
  },
);

export default Textarea;
