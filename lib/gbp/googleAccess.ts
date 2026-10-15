import "server-only";
import { listSalonGoogleBindings, markBindingScope } from "@/lib/google/db/bindings";
import { getGoogleAccount } from "@/lib/google/db/accounts";
import { obtainGoogleAccessToken } from "@/lib/google/accessToken";
import { classifyGoogleError } from "@/lib/google/errors";
import { isSimulatedGoogleEnabled } from "@/lib/google/config";
import { getGoogleFlowDeps } from "@/lib/google/runtime";
import { logSafeError } from "@/lib/google/safeError";
import { GbpTokenError, grantsGbp, type GbpAccess, type GbpBinding } from "@/lib/gbp/access";
import { simulatedGbpToken } from "@/lib/gbp/simulated";

// 共通の Google 連携(lib/google/*)を使った GbpAccess の実装(サーバーだけ)。決まりは lib/gbp/access.ts。

const TOKEN_TTL_MS = 30 * 60_000;
const tokens = new Map<string, { token: string; expiresAt: number; generation: number }>();

export function createGoogleGbpAccess(): GbpAccess {
  return {
    async binding(salonId): Promise<GbpBinding | null> {
      const all = await listSalonGoogleBindings(salonId);
      const b = all.find((x) => x.feature === "gbp");
      if (!b) return null;
      return {
        googleAccountId: b.googleAccountId,
        googleSub: b.account.googleSub,
        email: b.accountEmail ?? b.account.email,
        authState: b.account.authState,
        scopeMissing: b.scopeMissingSince !== null,
        scopeGranted: grantsGbp(b.account.grantedScopes),
        selectionState: b.gbpSelectionState === "selected" ? "selected" : "selection_pending",
        accountBoundAt: b.accountBoundAt,
      };
    },

    async accessToken(binding, options = {}) {
      const cached = tokens.get(binding.googleAccountId);
      const account = await getGoogleAccount(binding.googleAccountId);
      if (!account || account.authState !== "active" || !account.sealed) throw new GbpTokenError("invalid_grant");
      if (!options.fresh && cached && cached.generation === account.tokenGeneration && cached.expiresAt > Date.now() + 60_000) {
        return cached.token;
      }
      let result: { accessToken: string; scopes: string[] | null };
      try {
        result = await obtainGoogleAccessToken(account, getGoogleFlowDeps());
      } catch (error) {
        const kind = classifyGoogleError(error);
        if (kind === "invalid_grant") throw new GbpTokenError("invalid_grant");
        logSafeError("gbp/token", error);
        throw new GbpTokenError("unavailable");
      }
      // トークンの応答の scope が分かり、口コミの権限が無いと確かめられたときだけ「権限が足りない」にする。
      if (result.scopes && !grantsGbp(result.scopes)) throw new GbpTokenError("scope_missing");
      const token = isSimulatedGoogleEnabled() ? simulatedGbpToken(account.googleSub, result.accessToken) : result.accessToken;
      tokens.set(binding.googleAccountId, { token, expiresAt: Date.now() + TOKEN_TTL_MS, generation: account.tokenGeneration });
      return token;
    },

    async markScopeMissing(salonId, grantedScopes) {
      try {
        await markBindingScope({ salonId, feature: "gbp", missing: true, grantedScopes });
      } catch (error) {
        logSafeError("gbp/mark-scope", error);
      }
    },
  };
}
