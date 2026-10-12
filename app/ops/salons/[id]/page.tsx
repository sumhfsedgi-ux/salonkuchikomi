import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireOperator } from "@/lib/ops/operator";
import { getSalonDetail, listAuditLog, type AuditEntry } from "@/lib/ops/queries";
import { ACTOR_KIND_LABELS, PLAN_LABELS, formatJst } from "@/lib/ops/labels";
import { FEATURE_CATEGORIES, FEATURE_REGISTRY, getFeatureDefinition, isFeatureKey } from "@/lib/features/registry";
import { LIFECYCLE_LABELS } from "@/lib/features/entitlements";
import { switchLabel } from "@/lib/ops/toggle";
import type { PlanRules } from "@/lib/ops/preview";
import type { SalonPlan } from "@/lib/access/plan";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import { buttonClassName } from "@/components/ui/Button";
import EntitlementEditor, { type EditorFeature } from "@/components/ops/EntitlementEditor";
import HoldReleasePanel from "@/components/ops/HoldReleasePanel";
import { remainingAfterRelease, summarizeReservation } from "@/lib/ops/reservationSummary";

// サロン詳細(運営管理)。基本情報・連携と稼働状況は閲覧のみ(秘密の値は読まない・出さない)。
// 契約と利用許可は EntitlementEditor で、確認のうえ保存する。権限による停止の解除は、利用許可の保存とは別の操作。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-4 flex-col gap-3">
      <div>
        <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function prerequisites(key: string): string[] {
  const def = getFeatureDefinition(key as never);
  const out: string[] = [];
  if (def.googleFeature === "gmail") out.push("Google連携(予約受信用のGmail)");
  if (def.googleFeature === "gbp") out.push("Google連携(Googleビジネスプロフィール)");
  if (def.requiresLine) out.push("LINEの通知先");
  return out;
}

function auditTarget(target: string): string {
  if (target === "plan") return "契約プラン";
  const [kind, key, extra] = target.split(":");
  const label = key && isFeatureKey(key) ? getFeatureDefinition(key).label : key;
  switch (kind) {
    case "feature":
      return label;
    case "hold":
      return `${label}の権限による停止`;
    case "catalog":
      return `${label}の提供状態(全体)`;
    case "plan_rule":
      return `${extra && isFeatureKey(extra) ? getFeatureDefinition(extra).label : extra}のプラン標準(${key})`;
    default:
      return target;
  }
}

/**
 * 機能のプラン内の標準(変更履歴の個別設定を、スイッチと同じ「利用中/停止」で読むため)。
 * 個別設定が効くのは対象プランのときだけなので、今の契約が対象外なら、その機能を含むプランの標準で読む。
 */
function featureDefaultOn(rules: PlanRules, plan: SalonPlan, key: string): boolean {
  return rules[plan]?.[key] ?? rules.salonpack?.[key] ?? rules.reviews?.[key] ?? true;
}

function auditValue(target: string, value: unknown, defaultOn: (key: string) => boolean): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    if (target === "plan" && (value === "reviews" || value === "salonpack")) return PLAN_LABELS[value];
    if (value === "inherit" || value === "allow" || value === "deny") return switchLabel(value, defaultOn(target.split(":")[1] ?? ""));
    if (value === "open") return "停止";
    if (value === "released") return "解除";
    if (value === "none") return "なし";
    return value;
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.lifecycle === "string" && v.lifecycle in LIFECYCLE_LABELS) return LIFECYCLE_LABELS[v.lifecycle as keyof typeof LIFECYCLE_LABELS];
    if (typeof v.default_enabled === "boolean") return v.default_enabled ? "標準で利用可" : "標準で利用不可";
    if (typeof v.opened_at === "string") return `停止(${formatJst(v.opened_at)}から)`;
  }
  return JSON.stringify(value);
}

function actorText(e: AuditEntry): string {
  if (e.actorKind === "operator") return e.actorEmail ?? "管理者";
  if (e.actorKind === "system") return e.actorEmail ? `自動(${e.actorEmail} の変更による)` : `自動(${e.actorLabel ?? "—"} の変更による)`;
  return `${ACTOR_KIND_LABELS[e.actorKind] ?? e.actorKind}${e.actorLabel ? `(${e.actorLabel})` : ""}`;
}

export default async function OpsSalonDetailPage({ params, searchParams }: PageProps<"/ops/salons/[id]">) {
  await requireOperator();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const query = await searchParams;
  const beforeRaw = Array.isArray(query.historyBefore) ? query.historyBefore[0] : query.historyBefore;
  const historyBefore = beforeRaw && /^\d+$/.test(beforeRaw) ? beforeRaw : null;
  const releasedRaw = Array.isArray(query.released) ? query.released[0] : query.released;
  const released = releasedRaw && isFeatureKey(releasedRaw) ? getFeatureDefinition(releasedRaw) : null;

  const [detail, audit] = await Promise.all([getSalonDetail(id), listAuditLog(id, historyBefore)]);
  if (!detail) notFound();
  const defaultOn = (key: string) => featureDefaultOn(detail.rules, detail.plan, key);

  const features: EditorFeature[] = FEATURE_REGISTRY.filter((d) => d.entitlement === "catalog" && detail.entitlements[d.key]).map((d) => {
    const e = detail.entitlements[d.key]!;
    return {
      key: d.key,
      label: d.label,
      description: d.description,
      category: d.category,
      sortOrder: d.sortOrder,
      icon: d.icon,
      hasRuntime: e.hasRuntime,
      lifecycle: e.lifecycle,
      override: e.override,
      allowed: e.allowed,
      reason: e.reason,
      holdOpen: e.holdOpen,
      prerequisites: prerequisites(d.key),
    };
  });
  const r = detail.reservation;
  const reservationStarted = r.state !== null && r.state !== "setup_pending";
  const gmail = detail.google.find((g) => g.feature === "gmail") ?? null;
  const reservation = summarizeReservation({
    entitled: Boolean(detail.entitlements.reservation_notifications?.allowed),
    holdOpen: detail.holds.some((h) => h.featureKey === "reservation_notifications"),
    reservation: r,
    gmail,
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href="/ops/salons" className="text-sm text-sage-dark underline underline-offset-2">
          ← サロン一覧へ
        </Link>
        <PageHeader title={detail.name} description={`${PLAN_LABELS[detail.plan]}・登録日 ${formatJst(detail.createdAt)}`} />
        <nav aria-label="このページの項目" className="flex flex-wrap gap-2">
          {[
            ["#basic", "基本情報"],
            ["#entitlements", "契約と利用許可"],
            ["#integrations", "連携と稼働状況"],
            ["#history", "変更履歴"],
          ].map(([href, label]) => (
            <a key={href} href={href} className={buttonClassName({ variant: "secondary", size: "sm" })}>
              {label}
            </a>
          ))}
        </nav>
      </div>

      <Section id="basic" title="基本情報" description="閲覧のみです。">
        <Card>
          <dl className="divide-y divide-border">
            <Row label="店舗名">{detail.name}</Row>
            <Row label="登録メールアドレス(ログイン用)">{detail.ownerEmail ?? "—"}</Row>
            <Row label="業種">{detail.businessType ?? "—"}</Row>
            <Row label="お客様用ページ">/review/{detail.slug}</Row>
            <Row label="Google口コミ投稿URL">{detail.googleReviewUrl ?? "未設定"}</Row>
            <Row label="初期設定">{detail.onboardingCompleted ? "完了" : "未完了"}</Row>
            <Row label="最終更新">{formatJst(detail.updatedAt)}</Row>
          </dl>
        </Card>
      </Section>

      <Section
        id="entitlements"
        title="契約と利用許可"
        description="選択を変えただけでは保存されません。「変更を保存」で内容と影響を確認してから保存します。利用許可だけでは、Google・LINEの連携や予約通知の送信は始まりません。"
      >
        <EntitlementEditor
          salonId={detail.id}
          version={detail.version}
          plan={detail.plan}
          features={features}
          categories={FEATURE_CATEGORIES}
          catalog={detail.catalog}
          rules={detail.rules}
          reservationStarted={reservationStarted}
        />
      </Section>

      <Section id="integrations" title="連携と稼働状況" description="閲覧のみです(権限による停止の解除を除く)。">
        {released && !detail.holds.some((h) => h.featureKey === released.key) && (
          <Alert variant="success">
            {released.label}の権限による停止を解除しました。
            {released.key === "reservation_notifications" && remainingAfterRelease(reservation).length > 0
              ? `次の理由で、まだ通知していません: ${remainingAfterRelease(reservation).join(" ")}`
              : "ほかに止まっている理由はありません。"}
          </Alert>
        )}
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">予約通知</h3>
            <Badge variant={reservation.sending ? "success" : "neutral"} dot={reservation.sending}>
              {reservation.sending ? "通知しています" : "通知していません"}
            </Badge>
          </div>
          {reservation.reasons.length > 0 && (
            <div>
              <p className="text-sm text-ink-muted">止まっている理由</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
                {reservation.reasons.map((reason) => (
                  <li key={reason.key}>{reason.text}</li>
                ))}
              </ul>
            </div>
          )}
          <dl className="divide-y divide-border">
            <Row label="予約受信用のGmail">
              {gmail ? `${gmail.accountEmail ?? "—"}(${gmail.authState === "active" && !gmail.scopeMissingSince ? "連携済み" : "再接続が必要"})` : "未連携"}
            </Row>
            <Row label="LINEの通知先">{r.lineRecipients}人</Row>
            {r.state === "active" && (
              <>
                <Row label="通知の開始">{formatJst(r.activatedAt)}</Row>
                <Row label="最後に予約メールを確認">{formatJst(r.lastMailCheckAt)}</Row>
              </>
            )}
          </dl>
        </Card>

        {detail.holds.map((h) => {
          const def = getFeatureDefinition(h.featureKey);
          const e = detail.entitlements[h.featureKey];
          return (
            <Card key={h.id} className="flex flex-col gap-3 border-warning/40">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">権限による停止中</Badge>
                <h3 className="text-base font-semibold text-ink">{def.label}</h3>
              </div>
              <p className="text-sm text-ink">
                {formatJst(h.openedAt)}に利用不可になったため止めています。再び許可しただけでは再開しません。
              </p>
              <HoldReleasePanel
                salonId={detail.id}
                featureKey={h.featureKey as "reservation_notifications" | "reviews" | "blog"}
                featureLabel={def.label}
                holdId={h.id}
                entitled={Boolean(e?.allowed)}
                remaining={h.featureKey === "reservation_notifications" ? remainingAfterRelease(reservation) : []}
              />
            </Card>
          );
        })}
      </Section>

      <Section id="history" title="変更履歴" description="管理画面・運用CLI・SQLによる変更を記録しています(編集・削除はできません)。">
        {audit.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-muted">変更履歴はありません。</p>
          </Card>
        ) : (
          <Card className="p-0">
            <ol className="divide-y divide-border">
              {audit.rows.map((e) => (
                <li key={e.id} className="flex flex-col gap-1 px-5 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                    <time dateTime={e.occurredAt}>{formatJst(e.occurredAt)}</time>
                    <span>{actorText(e)}</span>
                  </div>
                  <p className="text-sm text-ink">
                    {auditTarget(e.target)}: {auditValue(e.target, e.before, defaultOn)} → {auditValue(e.target, e.after, defaultOn)}
                  </p>
                  {e.note && <p className="whitespace-pre-line text-xs text-ink-muted">メモ: {e.note}</p>}
                </li>
              ))}
            </ol>
          </Card>
        )}
        <div className="flex flex-wrap gap-3">
          {historyBefore && (
            <Link href={`/ops/salons/${detail.id}#history`} className={buttonClassName({ variant: "secondary", size: "sm" })}>
              最新の履歴へ
            </Link>
          )}
          {audit.nextBefore && (
            <Link href={`/ops/salons/${detail.id}?historyBefore=${audit.nextBefore}#history`} className={buttonClassName({ variant: "secondary", size: "sm" })}>
              さらに古い履歴
            </Link>
          )}
        </div>
      </Section>
    </div>
  );
}
