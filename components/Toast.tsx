"use client";

import { useEffect } from "react";

interface Props {
  message: string | null;
  onDismiss: () => void;
}

export default function Toast({ message, onDismiss }: Props) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, 2000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center px-4">
      <div className="rounded-full bg-stone-800 px-4 py-2 text-sm text-white shadow-lg">
        {message}
      </div>
    </div>
  );
}
