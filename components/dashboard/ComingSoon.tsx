import type { ComponentType, SVGProps } from "react";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";

interface ComingSoonProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  pageDescription: string;
  bodyText: string;
}

// Shared by /dashboard/blog and /dashboard/notifications: a purely static
// section (no props from a database, no client-side fetch) until each is
// actually wired up to blog-app / hmail. Deliberately makes no API/DB call
// of any kind -- verified via DevTools Network tab per the approved plan.
export default function ComingSoon({ icon: Icon, title, pageDescription, bodyText }: ComingSoonProps) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={pageDescription} />
      <Card className="flex flex-col items-center gap-4 py-12 text-center md:py-10">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sage-soft text-sage-dark" aria-hidden="true">
          <Icon className="h-6 w-6" />
        </span>
        <Badge variant="neutral">準備中</Badge>
        <p className="max-w-sm text-sm text-ink-muted">{bodyText}</p>
      </Card>
    </div>
  );
}
