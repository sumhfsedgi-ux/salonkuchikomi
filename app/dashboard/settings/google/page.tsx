import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { loadSetupContext } from "@/lib/features/setupContext";
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
  feature_not_selected: { variant: "error", text: "利用する機能に選ばれていない機能です。" },
  not_available: { variant: "warning", text: "この機能のGoogle連携は準備中です。" },
  disconnected: { variant: "success", text: "Google連携を解除しました。" },
  stopped_gmail: { variant: "success", text: "予約通知の利用を停止しました(Googleの許可はそのままです)。" },
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

function FeatureCard({ state, binding }: { state: FeatureState; binding: SalonGoogleBinding | undefined }) {
  const google = state.definition.googleFeature!;
  const comingSoon = state.status === "coming_soon";
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
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
        <dt className="text-ink-muted">Googleアカウント</dt>
        <dd className="truncate text-ink">{binding?.accountEmail ?? binding?.account.email ?? "—"}</dd>
        <dt className="text-ink-muted">権限</dt>
        <dd className="text-ink">{comingSoon ? "—" : permission}</dd>
      </dl>
      {state.message && <p className="whitespace-pre-line text-sm text-ink-muted">{state.message}</p>}
      {!comingSoon && (
        <div className="flex flex-wrap gap-2">
          {!binding && <ConnectButton features={[google]} purpose="connect" label="Googleと連携する" />}
          {needsReauth && <ConnectButton features={[google]} purpose="reauth" label="Googleに再接続する" />}
          {missingScope && <ConnectButton features={[google]} purpose="add_scope" label="権限を追加する" />}
        </div>
      )}
      {!comingSoon && state.selected && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-muted">その他の操作</summary>
          <div className="mt-2 flex flex-col gap-2">
            {binding && <ConnectButton features={[google]} purpose="switch_account" label="別のGoogleアカウントに切り替える" variant="secondary" />}
            <form action={stopFeatureAction}>
              <input type="hidden" name="feature" value={google} />
              <button type="submit" className={buttonClassName({ variant: "ghost", size: "sm" })}>
                {state.definition.label}の利用を停止する
              </button>
            </form>
            <p className="text-xs text-ink-muted">利用を停止しても、Googleの許可や他の機能の連携は解除されません。</p>
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
  const googleStates = states.filter((s) => s.definition.googleFeature && (s.selected || s.status === "coming_soon"));
  const selectedGoogle = googleStates.filter((s) => s.selected);
  const unbound = selectedGoogle.filter((s) => !bindings.some((b) => b.feature === s.definition.googleFeature));
  const result = params.google ? RESULT_MESSAGES[params.google] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Google連携" description="予約通知・届いた口コミで使うGoogleアカウントの連携を管理します。" />

      {result && (
        <Alert variant={result.variant}>
          {result.text}
          {params.google === "connected" && params.missing ? " 一部の権限は許可されなかったため、その機能はまだ連携していません。" : ""}
        </Alert>
      )}

      {selectedGoogle.length === 0 && (
        <Card className="text-sm text-ink-muted">
          Googleとの連携が必要な機能は選ばれていません。
          <Link href="/dashboard/settings" className="ml-1 text-sage-dark underline underline-offset-2">
            利用する機能
          </Link>
          から選べます。
        </Card>
      )}

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

      {googleStates.map((state) => (
        <FeatureCard key={state.key} state={state} binding={bindings.find((b) => b.feature === state.definition.googleFeature)} />
      ))}

      {bindings.length > 0 && (
        <Card className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink">Google連携をすべて解除</p>
          <p className="text-xs text-ink-muted">
            この店舗の予約通知・届いた口コミの連携をすべて外します。同じGoogleアカウントを他の店舗で使っている場合、
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
