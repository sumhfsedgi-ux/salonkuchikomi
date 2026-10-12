import Link from "next/link";
import { requireOperator } from "@/lib/ops/operator";
import { listSalons, type SalonListCursor } from "@/lib/ops/queries";
import { PLAN_LABELS, formatJst } from "@/lib/ops/labels";
import { FEATURE_CATEGORIES, FEATURE_REGISTRY, isFeatureKey, type FeatureKey } from "@/lib/features/registry";
import type { SalonPlan } from "@/lib/access/plan";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import { buttonClassName } from "@/components/ui/Button";

// サロン一覧(運営管理)。店舗名・登録メールアドレスで検索し、プラン・機能の最終的な利用可否で絞り込む。
// 全件を一度に読まず、50件ずつ(作成日時の新しい順・続きから)読む。
const categoryOrder = (key: string) => FEATURE_CATEGORIES.findIndex((c) => c.key === key);
const CATALOG_FEATURES = FEATURE_REGISTRY.filter((d) => d.entitlement === "catalog").sort(
  (a, b) => categoryOrder(a.category) - categoryOrder(b.category) || a.sortOrder - b.sortOrder,
);

function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : null;
}

function parseCursor(raw: string | null): SalonListCursor | null {
  if (!raw) return null;
  const [createdAt, id] = raw.split("|");
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt, id };
}

export default async function OpsSalonsPage({ searchParams }: PageProps<"/ops/salons">) {
  await requireOperator();
  const params = await searchParams;
  const query = one(params.q)?.slice(0, 100) ?? null;
  const planRaw = one(params.plan);
  const plan: SalonPlan | null = planRaw === "reviews" || planRaw === "salonpack" ? planRaw : null;
  const featureRaw = one(params.feature);
  const featureKey: FeatureKey | null = featureRaw && isFeatureKey(featureRaw) && CATALOG_FEATURES.some((d) => d.key === featureRaw) ? featureRaw : null;
  const stateRaw = one(params.state);
  const featureAllowed = stateRaw === "allowed" ? true : stateRaw === "not_allowed" ? false : null;
  const after = parseCursor(one(params.after));

  const { rows, next } = await listSalons({ query, plan, featureKey, featureAllowed: featureKey ? featureAllowed : null, after });

  const baseQuery = new URLSearchParams();
  if (query) baseQuery.set("q", query);
  if (plan) baseQuery.set("plan", plan);
  if (featureKey) baseQuery.set("feature", featureKey);
  if (featureKey && featureAllowed !== null) baseQuery.set("state", featureAllowed ? "allowed" : "not_allowed");
  const nextHref = next ? `/ops/salons?${new URLSearchParams({ ...Object.fromEntries(baseQuery), after: `${next.createdAt}|${next.id}` })}` : null;
  const firstHref = `/ops/salons${baseQuery.size ? `?${baseQuery}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="サロン一覧" description="契約プランと、機能ごとの最終的な利用可否を確認できます。" />

      <Card>
        <form method="get" action="/ops/salons" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end">
          <div>
            <Label htmlFor="q">店舗名・登録メールアドレス</Label>
            <Input id="q" name="q" type="search" defaultValue={query ?? ""} maxLength={100} placeholder="一部だけでも検索できます" />
          </div>
          <div>
            <Label htmlFor="plan">契約プラン</Label>
            <select id="plan" name="plan" defaultValue={plan ?? ""} className="min-h-11 w-full rounded-lg border border-greige bg-white px-3 text-ink">
              <option value="">すべて</option>
              <option value="reviews">{PLAN_LABELS.reviews}</option>
              <option value="salonpack">{PLAN_LABELS.salonpack}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="feature">機能</Label>
            <select id="feature" name="feature" defaultValue={featureKey ?? ""} className="min-h-11 w-full rounded-lg border border-greige bg-white px-3 text-ink">
              <option value="">指定しない</option>
              {CATALOG_FEATURES.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="state">機能の利用可否</Label>
            <select id="state" name="state" defaultValue={stateRaw ?? ""} className="min-h-11 w-full rounded-lg border border-greige bg-white px-3 text-ink">
              <option value="">指定しない</option>
              <option value="allowed">利用可</option>
              <option value="not_allowed">利用不可</option>
            </select>
          </div>
          <button type="submit" className={buttonClassName({ variant: "primary" })}>
            検索
          </button>
        </form>
        {!featureKey && featureAllowed !== null && <p className="mt-3 text-xs text-ink-muted">利用可否で絞り込むときは、機能も選んでください。</p>}
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">条件に合うサロンはありません。</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="サロン">
          {rows.map((s) => (
            <li key={s.id}>
              <Card className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <Link href={`/ops/salons/${s.id}`} className="text-base font-semibold text-ink underline-offset-2 hover:underline">
                    {s.name}
                  </Link>
                  <p className="mt-0.5 break-all text-sm text-ink-muted">{s.ownerEmail ?? "(登録メールアドレスなし)"}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">登録日 {formatJst(s.createdAt)}</p>
                </div>
                <div className="flex flex-col gap-2 md:items-end">
                  <Badge variant={s.plan === "salonpack" ? "success" : "neutral"}>{PLAN_LABELS[s.plan]}</Badge>
                  <p className="text-sm text-ink md:text-right">
                    <span className="text-ink-muted">利用可能な機能:</span>{" "}
                    {CATALOG_FEATURES.filter((d) => s.entitled[d.key] === true).map((d) => d.label).join("・") || "なし"}
                  </p>
                  {CATALOG_FEATURES.some((d) => s.overrides[d.key] || s.openHolds.includes(d.key)) && (
                    <ul className="flex flex-wrap gap-1.5 md:justify-end" aria-label="個別設定・停止">
                      {CATALOG_FEATURES.filter((d) => s.overrides[d.key]).map((d) => (
                        <li key={`o-${d.key}`}>
                          <Badge variant="neutral">
                            {d.label}: {s.overrides[d.key] === "allow" ? "個別に許可" : "個別に利用不可"}
                          </Badge>
                        </li>
                      ))}
                      {CATALOG_FEATURES.filter((d) => s.openHolds.includes(d.key)).map((d) => (
                        <li key={`h-${d.key}`}>
                          <Badge variant="warning">{d.label}: 権限による停止中</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <nav className="flex flex-wrap items-center gap-3" aria-label="ページ送り">
        {after && (
          <Link href={firstHref} className={buttonClassName({ variant: "secondary", size: "sm" })}>
            最初から表示
          </Link>
        )}
        {nextHref && (
          <Link href={nextHref} className={buttonClassName({ variant: "secondary", size: "sm" })}>
            次の50件
          </Link>
        )}
      </nav>
    </div>
  );
}
