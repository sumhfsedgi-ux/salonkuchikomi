"use client";

import { useEffect } from "react";
import { cn } from "@/lib/cn";

type ToastVariant = "success" | "error";

interface Props {
  message: string | null;
  onDismiss: () => void;
  /** Defaults to "success" -- matches every pre-existing call site (copy confirmations). */
  variant?: ToastVariant;
}

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: "bg-ink text-white",
  error: "bg-danger text-white",
};

export default function Toast({ message, onDismiss, variant = "success" }: Props) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, 2000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
      role="status"
      aria-live="polite"
    >
      <div className={cn("rounded-full px-4 py-2 text-sm shadow-lg", VARIANT_CLASSES[variant])}>
        {message}
      </div>
    </div>
  );
}
