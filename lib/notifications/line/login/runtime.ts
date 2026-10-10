import { getLineLoginConfig, type LineLoginConfig } from "@/lib/notifications/line/login/config";
import { getDevSimulatedLineLogin } from "@/lib/notifications/line/login/simulated";
import { createHttpLineLoginTransport, type LineLoginTransport } from "@/lib/notifications/line/login/transport";

// 実行時に使う LINE ログインの組み立て。本番は HTTP。テスト用DBでの画面確認では擬似 LINE ログイン
// (本番ビルドでは選ばれない)。未有効化(LINE ログインチャネル未設定)なら null。

export function getLineLoginDeps(): { config: LineLoginConfig; transport: LineLoginTransport } | null {
  const config = getLineLoginConfig();
  if (!config) return null;
  return {
    config,
    transport: config.simulated ? getDevSimulatedLineLogin(config.channelId).transport : createHttpLineLoginTransport(),
  };
}
