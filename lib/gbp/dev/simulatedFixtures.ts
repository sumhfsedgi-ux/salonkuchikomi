import type { GoogleReviewJson } from "@/lib/gbp/apiClient";
import type { SimulatedGbpUser } from "@/lib/gbp/simulated";

// 架空の Google の口コミの API(lib/gbp/simulated.ts)に入れる、架空のアカウント・ビジネス・口コミ。
// 実在のお客様・店舗・Google のデータではない。テストと、テスト用DBでの画面確認でだけ使う。
// ユーザーの sub は、共通の Google 連携の擬似 Google(lib/google/simulated.ts)の既定のユーザーと同じにする
// (owner@example.test がビジネスを管理している。staff@example.test は管理しているビジネスが無い)。
// 写真の URL は名前解決されない .invalid のドメイン(ネットワークに出ない。画面は「画像を表示できません」になる)。

export const SIM_OWNER_SUB = "100000000000000000001";
export const SIM_STAFF_SUB = "100000000000000000002";

function reviews(location: string, base: number): GoogleReviewJson[] {
  const at = (hoursAgo: number) => new Date(base - hoursAgo * 3_600_000).toISOString();
  const name = (n: number) => `accounts/sim-1/${location}/reviews/sim-r${n}`;
  return [
    {
      name: name(1),
      reviewer: { displayName: "架空 花子" },
      starRating: "FIVE",
      comment: "(架空の口コミ)カットの相談にていねいに乗ってもらえました。",
      createTime: at(30),
      updateTime: at(30),
    },
    {
      name: name(2),
      reviewer: { isAnonymous: true },
      starRating: "TWO",
      comment: "(架空の口コミ)予約の時間から少し待ちました。",
      createTime: at(52),
      updateTime: at(50),
      reviewReply: { comment: "(架空の返信)ご来店ありがとうございました。", updateTime: at(49), reviewReplyState: "REJECTED", policyViolation: "OFF_TOPIC" },
    },
    {
      name: name(3),
      reviewer: { displayName: "架空 太郎" },
      starRating: "FOUR",
      comment: "",
      createTime: at(80),
      updateTime: at(80),
      reviewReply: { comment: "(架空の返信)★のご評価ありがとうございます。", updateTime: at(70), reviewReplyState: "APPROVED" },
      reviewReplyUrl: "https://reply.invalid/sim-r3",
    },
    {
      name: name(4),
      reviewer: { displayName: "架空 次郎" },
      starRating: "THREE",
      comment: "(架空の口コミ)写真つき。",
      createTime: at(120),
      updateTime: at(120),
      reviewMediaItems: [{ thumbnailUrl: "https://media.invalid/sim-photo.jpg", thumbnailLabel: "架空の写真" }],
    },
  ];
}

export function simulatedGbpUsers(base: number = Date.now()): SimulatedGbpUser[] {
  return [
    {
      sub: SIM_OWNER_SUB,
      accounts: [
        {
          name: "accounts/sim-1",
          accountName: "架空のサロン(本部)",
          locations: [
            {
              name: "locations/sim-101",
              title: "架空のサロン 渋谷店",
              address: "〒150-0000 東京都 渋谷区 架空1-2-3",
              hasVoiceOfMerchant: true,
              reviews: reviews("locations/sim-101", base),
              averageRating: 3.5,
              totalReviewCount: 4,
            },
            {
              name: "locations/sim-102",
              title: "架空のサロン 新宿店",
              address: "〒160-0000 東京都 新宿区 架空4-5-6",
              hasVoiceOfMerchant: true,
              reviews: reviews("locations/sim-102", base).slice(0, 2),
              averageRating: 3.5,
              totalReviewCount: 2,
            },
            {
              name: "locations/sim-103",
              title: "架空のサロン 準備中の店",
              address: null,
              hasVoiceOfMerchant: false,
              reviews: [],
              averageRating: null,
              totalReviewCount: 0,
            },
          ],
        },
      ],
    },
    { sub: SIM_STAFF_SUB, accounts: [] },
  ];
}
