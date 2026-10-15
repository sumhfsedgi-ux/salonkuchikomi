import {
  GbpLocationInactiveError,
  GbpStoreError,
  GbpSyncLeaseLostError,
  type BeginReplyOperation,
  type CachedReviewInput,
  type GbpStore,
  type InboxSummaryRow,
  type StartSendOutcome,
  type StoredReviewSummary,
} from "@/lib/gbp/store";
import type { GoogleReplyState, ReplyOperationState, ReviewBucket, ReviewMediaItem } from "@/lib/googleReviews/types";

// 届いた口コミの DB(0028・0029 の関数)を呼ぶ。DB の関数だけを使い、表を直接は読み書きしない。
// 関数を呼ぶ部分(RpcClient)は差し替えられる:本番・テスト用DB は Supabase のクライアント(service role)、
// ローカルの PostgreSQL のテストは scripts/localdb/rpcClient.ts(同じ JSON の形にそろえて返す)。

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean => v === true;
const iso = (v: unknown): string | null => (typeof v === "string" ? new Date(v).toISOString() : v instanceof Date ? v.toISOString() : null);

const OPERATIONS = new Set<ReplyOperationState>(["none", "sending", "unknown", "sent_checking", "send_failed", "replace_failed", "delete_failed"]);
const BUCKETS = new Set<ReviewBucket>(["unreplied", "attention", "replied"]);
const REPLY_STATES = new Set<GoogleReplyState>(["PENDING", "APPROVED", "REJECTED", "UNSPECIFIED"]);

function media(v: unknown): ReviewMediaItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Row => !!m && typeof m === "object" && typeof (m as Row).thumbnailUrl === "string")
    .map((m) => ({ thumbnailUrl: m.thumbnailUrl as string, label: str(m.label), videoUrl: str(m.videoUrl) }));
}

function reviewJson(r: CachedReviewInput) {
  return {
    review_key: r.reviewKey,
    review_name: r.reviewName,
    reviewer_name: r.reviewerName,
    reviewer_photo_url: r.reviewerPhotoUrl,
    is_anonymous: r.isAnonymous,
    star_rating: r.starRating,
    comment: r.comment,
    create_time: r.createTime,
    update_time: r.updateTime,
    reply_comment: r.replyComment,
    reply_update_time: r.replyUpdateTime,
    reply_state: r.replyState,
    policy_violation: r.policyViolation,
    media: r.media,
    reply_url: r.replyUrl,
  };
}

function summaryOf(row: Row): StoredReviewSummary {
  const operation = row.operation as ReplyOperationState;
  const bucket = row.bucket as ReviewBucket;
  const replyState = row.reply_state as GoogleReplyState | null;
  return {
    reviewIndexId: String(row.review_index_id),
    locationId: String(row.location_id),
    reviewerName: str(row.reviewer_name),
    reviewerPhotoUrl: str(row.reviewer_photo_url),
    isAnonymous: bool(row.is_anonymous),
    starRating: num(row.star_rating),
    comment: str(row.comment) ?? "",
    createTime: iso(row.create_time)!,
    updateTime: iso(row.update_time)!,
    replyComment: str(row.reply_comment),
    replyUpdateTime: iso(row.reply_update_time),
    replyState: replyState && REPLY_STATES.has(replyState) ? replyState : null,
    policyViolation: str(row.policy_violation),
    media: media(row.media),
    unread: bool(row.unread),
    isNew: bool(row.is_new),
    hasDraft: bool(row.has_draft),
    operation: OPERATIONS.has(operation) ? operation : "none",
    bucket: BUCKETS.has(bucket) ? bucket : "unreplied",
  };
}

const rows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : data && typeof data === "object" ? [data as Row] : []);

export function createRpcGbpStore(client: RpcClient): GbpStore {
  async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      const message = error.message ?? "";
      if (message.includes("gbp:location_inactive")) throw new GbpLocationInactiveError(fn);
      if (message.includes("gbp:sync_lease_lost")) throw new GbpSyncLeaseLostError(fn);
      const code = /gbp:([a-z_]+)/.exec(message)?.[1] ?? error.code ?? null;
      throw new GbpStoreError(fn, code);
    }
    return data;
  }

  return {
    async recordConsent(salonId, userId, version) {
      await call("gbp_record_consent", { p_salon_id: salonId, p_user_id: userId, p_version: version });
    },

    async hasConnectConsent(salonId, version) {
      return (await call("gbp_has_connect_consent", { p_salon_id: salonId, p_version: version })) === true;
    },

    async getInboxSummary(salonId): Promise<InboxSummaryRow | null> {
      const [row] = rows(await call("gbp_inbox_summary", { p_salon_id: salonId }));
      if (!row) return null;
      return {
        locationId: String(row.location_id),
        googleAccountId: String(row.google_account_id),
        accountName: String(row.account_name),
        locationName: String(row.location_name),
        title: str(row.title),
        averageRating: num(row.average_rating),
        totalReviewCount: num(row.total_review_count),
        ratingCachedAt: iso(row.rating_cached_at),
        lastSyncedAt: iso(row.last_synced_at),
        initialSyncDone: bool(row.initial_sync_done),
        syncInProgress: bool(row.sync_in_progress),
        hasExpired: bool(row.has_expired),
        newCount: num(row.new_count),
      };
    },

    async isLocationLinkedElsewhere(locationName, salonId) {
      return (await call("gbp_location_linked_elsewhere", { p_location_name: locationName, p_salon_id: salonId })) === true;
    },

    async selectLocation(input) {
      try {
        const data = await call("gbp_select_location", {
          p_salon_id: input.salonId,
          p_google_account_id: input.googleAccountId,
          p_account_name: input.accountName,
          p_location_name: input.locationName,
          p_title: input.title,
          p_address: input.address,
          p_user_id: input.userId,
        });
        return { ok: true, locationId: String(data) };
      } catch (err) {
        if (err instanceof GbpStoreError && (err.code === "linked_elsewhere" || err.code === "binding_changed")) {
          return { ok: false, reason: err.code };
        }
        throw err;
      }
    },

    async ingestReviews(salonId, locationId, syncLeaseToken, reviews, ttlSeconds) {
      if (reviews.length === 0) return [];
      const data = await call("gbp_ingest_reviews", {
        p_salon_id: salonId,
        p_location_id: locationId,
        p_sync_lease_token: syncLeaseToken,
        p_detected_via: "manual",
        p_reviews: reviews.map(reviewJson),
        p_ttl_seconds: ttlSeconds,
      });
      return rows(data).map((r) => ({ reviewIndexId: String(r.review_index_id), reviewKey: String(r.review_key), created: bool(r.created) }));
    },

    async beginSync(salonId, locationId, input) {
      const [row] = rows(
        await call("gbp_begin_sync", {
          p_salon_id: salonId,
          p_location_id: locationId,
          p_lease_seconds: input.leaseSeconds,
          p_full_after_seconds: input.fullRescanAfterSeconds,
          p_min_interval_seconds: input.minIntervalSeconds,
          p_overlap_seconds: input.overlapSeconds,
        }),
      );
      const outcome = row?.outcome;
      if (outcome === "started" || outcome === "continued") {
        return {
          status: outcome,
          leaseToken: String(row.lease_token),
          kind: row.run_kind === "delta" ? "delta" : "full",
          floor: iso(row.run_floor),
          resumeBefore: iso(row.run_resume_before),
          pageToken: str(row.run_page_token),
        };
      }
      if (outcome === "throttled") return { status: "throttled", lastSyncedAt: iso(row.synced_at) };
      if (outcome === "busy") return { status: "busy" };
      return { status: "inactive" };
    },

    async checkpointSync(salonId, locationId, leaseToken, input, leaseSeconds) {
      const data = await call("gbp_sync_checkpoint", {
        p_salon_id: salonId,
        p_location_id: locationId,
        p_lease_token: leaseToken,
        p_page_token: input.pageToken,
        p_resume_before: input.resumeBefore,
        p_newest: input.newest,
        p_average_rating: input.averageRating,
        p_total_review_count: input.totalReviewCount,
        p_lease_seconds: leaseSeconds,
      });
      return data === true;
    },

    async finishSync(salonId, locationId, leaseToken, input) {
      return iso(
        await call("gbp_finish_sync", {
          p_salon_id: salonId,
          p_location_id: locationId,
          p_lease_token: leaseToken,
          p_newest: input.newest,
          p_average_rating: input.averageRating,
          p_total_review_count: input.totalReviewCount,
        }),
      );
    },

    async releaseSync(salonId, locationId, leaseToken, input) {
      return iso(
        await call("gbp_release_sync", {
          p_salon_id: salonId,
          p_location_id: locationId,
          p_lease_token: leaseToken,
          p_contacted: input.contacted,
          p_failed: input.failed,
          p_hold_seconds: input.holdSeconds,
        }),
      );
    },

    async updateLocationInfo(salonId, locationId, title, address) {
      return (await call("gbp_update_location_info", { p_salon_id: salonId, p_location_id: locationId, p_title: title, p_address: address })) === true;
    },

    async listReviews(salonId, query) {
      const data = await call("gbp_list_reviews", {
        p_salon_id: salonId,
        p_filter: query.filter,
        p_rating: query.rating,
        p_sort: query.sort,
        p_offset: query.offset,
        p_limit: query.limit,
      });
      return rows(data).map(summaryOf);
    },

    async getReview(salonId, reviewIndexId) {
      const [row] = rows(await call("gbp_get_review", { p_salon_id: salonId, p_review_index_id: reviewIndexId }));
      if (!row) return { kind: "not_found" };
      if (!bool(row.location_usable)) return { kind: "stale" };
      if (bool(row.deleted_on_google)) return { kind: "deleted", draft: str(row.draft_text) ?? "" };
      if (!bool(row.cache_alive)) return { kind: "expired", locationId: String(row.location_id) };
      return {
        kind: "ok",
        review: {
          ...summaryOf({ ...row, has_draft: row.draft_text != null }),
          reviewName: String(row.review_name),
          replyUrl: str(row.reply_url),
          draft: str(row.draft_text) ?? "",
          draftUpdatedAt: str(row.draft_updated_at),
        },
      };
    },

    async setSeen(salonId, reviewIndexId, seen) {
      return (await call("gbp_set_seen", { p_salon_id: salonId, p_review_index_id: reviewIndexId, p_seen: seen })) === true;
    },

    async saveDraft(salonId, reviewIndexId, text, ttlSeconds) {
      // 下書きの更新時刻は、送信の終わりの記録で「送っている間に書き直していないか」を比べるため、DB の値をそのまま返す。
      const data = await call("gbp_save_draft", { p_salon_id: salonId, p_review_index_id: reviewIndexId, p_text: text, p_ttl_seconds: ttlSeconds });
      return str(data);
    },

    async markReviewDeleted(salonId, reviewIndexId) {
      return (await call("gbp_mark_review_deleted", { p_salon_id: salonId, p_review_index_id: reviewIndexId })) === true;
    },

    async beginReplyOperation(input): Promise<BeginReplyOperation> {
      const [row] = rows(
        await call("gbp_begin_reply_operation", {
          p_op_id: input.opId,
          p_salon_id: input.salonId,
          p_review_index_id: input.reviewIndexId,
          p_action: input.action,
          p_text_sha256: input.textSha256,
          p_byte_len: input.byteLength,
          p_base_reply_sha256: input.baseReplySha256,
          p_actor_user_id: input.actorUserId,
          p_lease_seconds: input.leaseSeconds,
          p_rate_per_minute: input.ratePerMinute,
        }),
      );
      const outcome = String(row?.outcome ?? "not_found");
      const operationId = str(row?.operation_id);
      const base = str(row?.base_reply_sha256);
      switch (outcome) {
        case "new":
        case "retry":
          return { outcome, operationId: operationId!, leaseToken: String(row.lease_token), baseReplySha256: base };
        case "done":
        case "failed":
        case "conflict":
        case "dismissed":
          return { outcome, operationId: operationId! };
        case "busy":
        case "mismatch":
        case "rate_limited":
        case "not_entitled":
          return { outcome };
        default:
          return { outcome: "not_found" };
      }
    },

    async startReplySend(salonId, operationId, leaseToken, input): Promise<StartSendOutcome> {
      const data = await call("gbp_reply_start_send", {
        p_salon_id: salonId,
        p_operation_id: operationId,
        p_lease_token: leaseToken,
        p_window_seconds: input.windowSeconds,
        p_reviews: input.reviews.map(reviewJson),
        p_ttl_seconds: input.ttlSeconds,
      });
      return data === "ok" || data === "not_entitled" || data === "location_changed" ? data : "lease_lost";
    },

    async finishReplyOperation(salonId, operationId, leaseToken, input) {
      const data = await call("gbp_finish_reply_operation", {
        p_salon_id: salonId,
        p_operation_id: operationId,
        p_lease_token: leaseToken,
        p_status: input.status,
        p_error_code: input.errorCode,
        p_reviews: input.reviews.map(reviewJson),
        p_ttl_seconds: input.ttlSeconds,
        p_clear_draft_updated_at: input.clearDraftUpdatedAt,
      });
      return data === true;
    },

    async reconcileReplyOperations(salonId, reviewIndexId, observed) {
      return (
        num(
          await call("gbp_reconcile_reply_operations", {
            p_salon_id: salonId,
            p_review_index_id: reviewIndexId,
            p_reply_sha256: observed.replySha256,
            p_reply_state: observed.replyState,
            p_reply_update_time: observed.replyUpdateTime,
          }),
        ) ?? 0
      );
    },

    async dismissReplyOperations(salonId, reviewIndexId) {
      return num(await call("gbp_dismiss_reply_operation", { p_salon_id: salonId, p_review_index_id: reviewIndexId })) ?? 0;
    },

    async deactivateSalonLocations(salonId) {
      return num(await call("gbp_deactivate_salon_locations", { p_salon_id: salonId })) ?? 0;
    },

    async purgeExpiredContent() {
      const data = (await call("gbp_purge_expired_content", {})) as Row | null;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(data ?? {})) out[k] = num(v) ?? 0;
      return out;
    },
  };
}
