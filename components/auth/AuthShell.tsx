import type { ReactNode } from "react";
import Logo from "@/components/ui/Logo";
import { SERVICE_TAGLINE } from "@/lib/brand";

interface AuthShellProps {
  /** Heading shown inside the card, above `children`. Omit for the login screen itself. */
  title?: string;
  description?: string;
  children: ReactNode;
}

// The single visual shell for every unauthenticated screen (login, forgot
// password, reset password, first-time password setup) -- centered card,
// logo + tagline above it, same card/border/radius tokens as the rest of
// the design system. Keeping this in one place is what makes those screens
// read as "one product" rather than one-off pages.
export default function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-ivory px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Logo />
          <p className="text-sm text-ink-muted">{SERVICE_TAGLINE}</p>
        </div>
        <div className="rounded-2xl border border-border bg-white p-6 sm:p-8">
          {title && (
            <div className="mb-6">
              <h1 className="text-lg font-semibold text-ink">{title}</h1>
              {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
