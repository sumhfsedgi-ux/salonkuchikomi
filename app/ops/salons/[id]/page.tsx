import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireOperator } from "@/lib/ops/operator";
import { getSalonDetail, listAuditLog } from "@/lib/ops/queries";
import { PLAN_LABELS, formatJst } from "@/lib/ops/labels";
import { FEATURE_CATEGORIES, FEATURE_REGISTRY, getFeatureDefinition, isFeatureKey } from "@/lib/features/registry";
import { describeAuditEntry } from "@/lib/ops/auditDisplay";
import { customerPageUrl, requestOrigin } from "@/lib/ops/customerPageUrl";
import { isLineInviteAvailable } from "@/lib/notifications/line/login/config";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import { buttonClassName } from "@/components/ui/Button";
import EntitlementEditor, { type EditorFeature } from "@/components/ops/EntitlementEditor";
import HoldReleasePanel from "@/components/ops/HoldReleasePanel";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import {
  ACTION_OWNER_LABELS,
  RESERVATION_STATUS_LABELS,
  remainingAfterRelease,
  summarizeReservation,
  type ReservationStatus,
} from "@/lib/ops/reservationSummary";
import type { BadgeVariant } from "@/components/ui/Badge";

// サロン詳細(運営管理)。基本情報・連携と稼働状況は閲覧のみ(秘密の値は読まない・出さない)。
// 契約プラン・使える機能(利用許可)は EntitlementEditor で、確認のうえ保存する。実際に動いているかは「連携と稼働状況」で出し、
// 利用許可だけを根拠に「通知中」とは出さない。権限による停止の解除は、利用許可の保存とは別の操作。

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
      {/* 長いメールアドレス・URLでも枠からはみ出さない。 */}
      <dd className="min-w-0 text-sm text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const REASON_HEADINGS: Record<ReservationStatus, string> = {
  sending: "",
  unverified: "確認できない理由と、必要な対応",
  stopped: "止まっている理由と、次に必要な対応",
  awaiting_cutover: "通知していない理由と、次に必要な対応",
  setup_required: "通知していない理由と、次に必要な対応",
  not_in_use: "利用していない理由",
};

const STATUS_BADGES: Record<ReservationStatus, BadgeVariant> = {
  sending: "success",
  unverified: "warning",
  stopped: "warning",
  awaiting_cutover: "neutral",
  setup_required: "warning",
  not_in_use: "neutral",
};

function prerequisites(key: string): string[] {
  const def = getFeatureDefinition(key as never);
  const out: string[] = [];
  if (def.googleFeature === "gmail") out.push("Google連携(予約受信用のGmail)");
  if (def.googleFeature === "gbp") out.push("Google連携(Googleビジネスプロフィール)");
  if (def.requiresLine) out.push("LINEの通知先");
  return out;
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

  const [detail, audit, headerList] = await Promise.all([getSalonDetail(id), listAuditLog(id, historyBefore), headers()]);
  if (!detail) notFound();
  const origin = requestOrigin(headerList);
  const customerUrl = origin ? customerPageUrl(origin, detail.slug) : null;

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
  const reservationAccess = detail.entitlements.reservation_notifications;
  const reservation = summarizeReservation({
    entitlement: reservationAccess ? { allowed: reservationAccess.allowed, reason: reservationAccess.reason } : null,
    holdOpen: detail.holds.some((h) => h.featureKey === "reservation_notifications"),
    reservation: r,
    gmail,
    lineInvitesAvailable: isLineInviteAvailable(),
    now: new Date(),
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href="/ops/salons" className="text-sm text-sage-dark underline underline-offset-2">
          ← サロン一覧へ
        </Link>
        <PageHeader title={detail.name} description={`${PLAN_LABELS[detail.plan]}・登録日 ${formatJst(detail.createdAt)}`} />
        <nav aria-labelledby="page-menu-title" className="flex flex-col gap-1.5">
          <p id="page-menu-title" className="text-xs text-ink-muted">
            ページ内メニュー
          </p>
          <div className="flex flex-wrap gap-2">
            {[
              ["#basic", "基本情報"],
              ["#entitlements", "契約プラン・使える機能"],
              ["#integrations", "連携と稼働状況"],
              ["#history", "変更履歴"],
            ].map(([href, label]) => (
              <a key={href} href={href} className={buttonClassName({ variant: "secondary", size: "sm", className: "whitespace-nowrap" })}>
                {label}
              </a>
            ))}
          </div>
        </nav>
      </div>

      <Section id="basic" title="基本情報">
        <Card>
          <dl className="divide-y divide-border">
            <Row label="店舗名">{detail.name}</Row>
            <Row label="ログイン用メールアドレス">{detail.ownerEmail ?? "—"}</Row>
            <Row label="業種">{detail.businessType ?? "—"}</Row>
            <Row label="お客様用ページ">
              <span className="block">{customerUrl ?? `/review/${detail.slug}`}</span>
              {customerUrl && (
                <span className="mt-2 flex flex-wrap gap-2">
                  <a href={customerUrl} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "secondary", size: "sm" })}>
                    開く<span className="sr-only">(新しいタブで開きます)</span>
                  </a>
                  <CopyUrlButton url={customerUrl} label="URLをコピー" />
                </span>
              )}
            </Row>
            <Row label="Google口コミ投稿URL">{detail.googleReviewUrl ?? "未設定"}</Row>
            {/* onboarding_completed は、口コミの初期設定(アンケートの作成 → 質問の確認 → Google口コミ投稿URLの入力)の
                最後の手順を終えたときにだけ立つ(app/dashboard/actions.ts の completeOnboardingAction)。URLは空のままでも終えられる。 */}
            <Row label="口コミの初期設定">
              {detail.onboardingCompleted ? "完了" : "未完了"}
              <span className="mt-0.5 block text-xs text-ink-muted">
                アンケートの作成から、Google口コミ投稿URLの入力(省略できます)まで終えたかどうかです。
              </span>
            </Row>
            <Row label="店舗情報の最終更新">{formatJst(detail.updatedAt)}</Row>
          </dl>
        </Card>
      </Section>

      <Section id="entitlements" title="契約プラン・使える機能" description="使える機能を変更できます。変更内容を確認してから保存します。">
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

      <Section id="integrations" title="連携と稼働状況">
        {released && !detail.holds.some((h) => h.featureKey === released.key) && (
          <Alert variant="success">
            {released.label}の権限による停止を解除しました。
            {released.key === "reservation_notifications" && remainingAfterRelease(reservation).length > 0
              ? `次の理由で、まだ通知していません: ${remainingAfterRelease(reservation).join(" ")}`
              : "ほかに止まっている理由はありません。"}
          </Alert>
        )}
        <Card className="flex flex-col gap-4" data-reservation-status={reservation.status}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">予約通知</h3>
            <Badge variant={STATUS_BADGES[reservation.status]} dot={reservation.status === "sending"} className="whitespace-nowrap">
              {RESERVATION_STATUS_LABELS[reservation.status]}
            </Badge>
          </div>
          {reservation.reasons.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-ink">{REASON_HEADINGS[reservation.status]}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {reservation.reasons.map((reason) => (
                  <li key={reason.key} className="rounded-lg border border-border px-3 py-2.5">
                    <p className="text-sm text-ink">{reason.text}</p>
                    {reason.action && (
                      <p className="mt-1 text-sm text-ink-muted">
                        <span className="font-medium text-ink">対応:</span> {reason.action}
                        {reason.owner && (
                          <span className="ml-1 inline-block whitespace-nowrap rounded-md bg-beige px-1.5 py-0.5 text-xs text-ink">担当: {ACTION_OWNER_LABELS[reason.owner]}</span>
                        )}
                      </p>
                    )}
                  </li>
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
                <Badge variant="warning" className="whitespace-nowrap">権限による停止中</Badge>
                <h3 className="text-base font-semibold text-ink">{def.label}</h3>
              </div>
              {/* 解除の操作の近くで、解除が必要な理由と、解除しても残るものを説明する。 */}
              <p className="text-sm text-ink">
                {formatJst(h.openedAt)}に利用許可がなくなったため止めています。利用を許可しただけでは再開せず、ここでの解除が必要です(運営側)。
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

      <Section id="history" title="変更履歴" description="契約プランや利用できる機能の変更履歴です。">
        {audit.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-muted">変更履歴はありません。</p>
          </Card>
        ) : (
          <Card className="p-0">
            <ol className="divide-y divide-border">
              {audit.rows.map((e) => {
                const view = describeAuditEntry(e, { rules: detail.rules, plan: detail.plan });
                return (
                  <li key={e.id} className="flex flex-col gap-1 px-5 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                      <time dateTime={e.occurredAt}>{formatJst(e.occurredAt)}</time>
                      <span className="[overflow-wrap:anywhere]">{view.actor}</span>
                    </div>
                    <p className="text-sm text-ink">{view.change}</p>
                    {view.memo && <p className="whitespace-pre-line text-xs text-ink-muted [overflow-wrap:anywhere]">メモ: {view.memo}</p>}
                  </li>
                );
              })}
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
