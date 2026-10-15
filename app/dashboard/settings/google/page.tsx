import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { loadSetupContext } from "@/lib/features/setupContext";
import { getPlanExperience, isFeatureIntroduced } from "@/lib/features/access";
import { resolveFeatureStates, type FeatureState } from "@/lib/features/featureState";
import { listSalonGoogleBindings, type SalonGoogleBinding } from "@/lib/google/db/bindings";
import { hasScopeFor, type GoogleFeature } from "@/lib/google/scopes";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import { buttonClassName } from "@/components/ui/Button";
import { disconnectAllGoogleAction, startGoogleConnectAction, stopFeatureAction } from "@/app/dashboard/settings/google/actions";

export const dynamic = "force-dynamic";

const RESULT_MESSAGES: Record<string, { variant: "success" | "error" | "warning"; text: string }> = {
  connected: { variant: "success", text: "Googleとの連携が完了しました。" },
  denied: { variant: "warning", text: "Googleで許可されませんでした。必要なときにもう一度お試しください。" },
  state_invalid: { variant: "error", text: "連携の途中でログイン状態や店舗が変わったか、時間がたちすぎたため中止しました。もう一度お試しください。" },
  account_mismatch: { variant: "error", text: "連携中のGoogleアカウントと違うアカウントが選ばれたため、保存していません。" },
  no_scope_granted: { variant: "warning", text: "必要な権限が許可されなかったため、連携していません。" },
  no_refresh_token: { variant: "error", text: "Googleから必要な情報を受け取れませんでした。もう一度お試しください。" },
  scope_regression: { variant: "error", text: "今まで許可されていた権限が含まれていなかったため、連携を変更していません。" },
  revocation_in_progress: { variant: "warning", text: "以前の連携の解除を処理しています。少し時間をおいてもう一度お試しください。" },
  gmail_account_in_use: { variant: "error", text: "このGmailは別の店舗の予約通知で使われているため、連携できません。" },
  feature_not_allowed: { variant: "error", text: "ご契約に含まれていない機能です。" },
  not_available: { variant: "warning", text: "この機能のGoogle連携は準備中です。" },
  disconnected: { variant: "success", text: "Google連携を解除しました。" },
  stopped_gmail: { variant: "success", text: "予約通知の利用を停止しました(Googleの許可はそのままです)。再開は予約通知の画面からできます。" },
  stopped_gbp: { variant: "success", text: "届いた口コミの利用を停止しました(予約メールの連携はそのままです)。" },
};

/** その機能の権限があるか(許可された scope に含まれ、定期処理でも権限不足を検知していない)。 */
function hasFeatureScope(binding: SalonGoogleBinding, feature: GoogleFeature): boolean {
  return hasScopeFor(binding.account.grantedScopes, feature) && !binding.scopeMissingSince;
}

function permissionLabel(binding: SalonGoogleBinding | undefined, feature: GoogleFeature): string {
  if (!binding) return "未連携";
  if (binding.account.authState !== "active") return "再接続が必要です";
  return hasFeatureScope(binding, feature) ? "許可済み" : "権限が不足しています";
}

function ConnectButton({ features, purpose, label, variant = "primary" }: { features: GoogleFeature[]; purpose: string; label: string; variant?: "primary" | "secondary" }) {
  return (
    <form action={startGoogleConnectAction}>
      <input type="hidden" name="features" value={features.join(",")} />
      <input type="hidden" name="purpose" value={purpose} />
      <button type="submit" className={buttonClassName({ variant, size: "sm" })}>
        {label}
      </button>
    </form>
  );
}

// canStop: 「利用を停止する」を出すか。予約通知は内部スイッチが ON のとき、届いた口コミは連携があるとき
// (止めるものが無いときにボタンを出さない)。
function FeatureCard({ state, binding, canStop }: { state: FeatureState; binding: SalonGoogleBinding | undefined; canStop: boolean }) {
  const google = state.definition.googleFeature!;
  const comingSoon = state.access !== "allowed";
  const permission = permissionLabel(binding, google);
  const needsReauth = binding && binding.account.authState !== "active";
  const missingScope = binding && binding.account.authState === "active" && !hasFeatureScope(binding, google);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-ink">{state.definition.label}</p>
        <Badge variant={state.status === "active" || state.status === "ready" || state.status === "setup_complete" ? "success" : state.status === "reconnect_required" || state.status === "checking" ? "warning" : "neutral"} dot>
          {state.statusLabel}
        </Badge>
      </div>
      {/* 狭い画面はラベルの下に値、sm 以上は2列(ラベルの列は一番長いラベルの幅)。ラベルは折り返さず、
          長いメールアドレスは省略せずに、どこででも折り返す(横にはみ出さない)。 */}
      <dl className="grid gap-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
          <dt className="whitespace-nowrap text-ink-muted">Googleアカウント</dt>
          <dd className="min-w-0 wrap-anywhere text-ink">{binding?.accountEmail ?? binding?.account.email ?? "—"}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
          <dt className="whitespace-nowrap text-ink-muted">権限</dt>
          <dd className="min-w-0 text-ink">{comingSoon ? "—" : permission}</dd>
        </div>
      </dl>
      {state.message && <p className="whitespace-pre-line text-sm text-ink-muted">{state.message}</p>}
      {!comingSoon && (
        <div className="flex flex-wrap gap-2">
          {!binding && <ConnectButton features={[google]} purpose="connect" label="Googleと連携する" />}
          {needsReauth && <ConnectButton features={[google]} purpose="reauth" label="Googleに再接続する" />}
          {missingScope && <ConnectButton features={[google]} purpose="add_scope" label="権限を追加する" />}
          {google === "gbp" && binding && !needsReauth && !missingScope && (
            <Link href="/dashboard/reviews/google" className={buttonClassName({ variant: "secondary", size: "sm" })}>
              {binding.gbpSelectionState === "selected" ? "届いた口コミを見る" : "口コミを受け取る店舗を選ぶ"}
            </Link>
          )}
        </div>
      )}
      {!comingSoon && (binding || canStop) && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-muted">その他の操作</summary>
          <div className="mt-2 flex flex-col gap-2">
            {binding && <ConnectButton features={[google]} purpose="switch_account" label="別のGoogleアカウントに切り替える" variant="secondary" />}
            {canStop && (
              <>
                <form action={stopFeatureAction}>
                  <input type="hidden" name="feature" value={google} />
                  <button type="submit" className={buttonClassName({ variant: "ghost", size: "sm" })}>
                    {state.definition.label}の利用を停止する
                  </button>
                </form>
                <p className="text-xs text-ink-muted">利用を停止しても、Googleの許可や他の機能の連携は解除されません。</p>
              </>
            )}
          </div>
        </details>
      )}
    </Card>
  );
}

export default async function GoogleSettingsPage({ searchParams }: { searchParams: Promise<{ google?: string; missing?: string }> }) {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");
  const params = await searchParams;

  const [ctx, bindings] = await Promise.all([loadSetupContext(salon), listSalonGoogleBindings(salon.id)]);
  const { states } = resolveFeatureStates(ctx);
  // 紹介してよい機能だけ(契約外は出さない。準備中は SalonPack だけ。lib/features/access.ts)。
  // 対象外になった機能の既存の連携も消さない(下の「すべて解除」は、連携があれば今まで通り出す)。
  const experience = getPlanExperience(salon.plan);
  // 届いた口コミは単独の入口を持たない(listed:false)ので、使える店舗にだけカードを出す(準備中・契約外の店舗には出さない)。
  const googleStates = states.filter(
    (s) =>
      s.definition.googleFeature &&
      (isFeatureIntroduced({ definition: s.definition, status: s.access }, experience, "guide") ||
        (s.key === "google_reviews" && s.access === "allowed")),
  );
  const usableGoogle = googleStates.filter((s) => s.access === "allowed");
  const unbound = usableGoogle.filter((s) => !bindings.some((b) => b.feature === s.definition.googleFeature));
  const result = params.google ? RESULT_MESSAGES[params.google] : undefined;
  const canStop = (state: FeatureState, binding: SalonGoogleBinding | undefined) =>
    state.key === "reservation_notifications" ? ctx.reservationSwitch?.selected === true : Boolean(binding);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Google連携"
        description={
          googleStates.length > 0
            ? `${googleStates.map((s) => s.definition.label).join("・")}で使うGoogleアカウントの連携を管理します。`
            : "Googleアカウントの連携を管理します。"
        }
      />

      {result && (
        <Alert variant={result.variant}>
          {result.text}
          {params.google === "connected" && params.missing ? " 一部の権限は許可されなかったため、その機能はまだ連携していません。" : ""}
        </Alert>
      )}

      {googleStates.length === 0 && <Card className="text-sm text-ink-muted">Googleとの連携が必要な機能はありません。</Card>}

      {unbound.length >= 2 && (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-ink">
            {unbound.map((s) => s.definition.label).join("・")}を、同じGoogleアカウントで管理していますか?
          </p>
          <div className="flex flex-wrap gap-2">
            <ConnectButton
              features={unbound.map((s) => s.definition.googleFeature!)}
              purpose="connect"
              label="同じGoogleアカウントでまとめて連携"
            />
          </div>
          <p className="text-xs text-ink-muted">
            別々のアカウントで管理している場合は、下のそれぞれの「Googleと連携する」から連携してください。
          </p>
        </Card>
      )}

      {googleStates.map((state) => {
        const binding = bindings.find((b) => b.feature === state.definition.googleFeature);
        return <FeatureCard key={state.key} state={state} binding={binding} canStop={canStop(state, binding)} />;
      })}

      {bindings.length > 0 && (
        <Card className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink">Google連携をすべて解除</p>
          <p className="text-xs text-ink-muted">
            この店舗のGoogle連携をすべて外します。同じGoogleアカウントを他の店舗で使っている場合、
            Googleでの許可の取り消しは行いません(その店舗の連携はそのまま使えます)。
          </p>
          <form action={disconnectAllGoogleAction} className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="confirm" value="yes" required /> 連携をすべて解除することを確認しました
            </label>
            <button type="submit" className={buttonClassName({ variant: "secondary", size: "sm", className: "w-fit" })}>
              すべて解除する
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
