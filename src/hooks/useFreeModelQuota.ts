import type { FreeModelQuotaStatus } from "@/ipc/types";

const FREE_MODEL_QUOTA_LIMIT = 5;

// Retired: the Pro free-model quota no longer exists (BYOK-only,
// opencode-style). This stub keeps the hook's shape so all call sites compile
// and behave as "unlimited".
const UNLIMITED_STATUS: FreeModelQuotaStatus = {
  messagesUsed: 0,
  messagesLimit: FREE_MODEL_QUOTA_LIMIT,
  messagesRemaining: FREE_MODEL_QUOTA_LIMIT,
  isQuotaExceeded: false,
  resetTime: null,
};

export function useFreeModelQuota({
  enabled = true,
}: { enabled?: boolean } = {}) {
  void enabled;
  return {
    quotaStatus: UNLIMITED_STATUS,
    isLoading: false,
    error: null,
    invalidateQuota: () => {},
    isQuotaExceeded: false,
    messagesUsed: 0,
    messagesLimit: FREE_MODEL_QUOTA_LIMIT,
    messagesRemaining: FREE_MODEL_QUOTA_LIMIT,
    resetTime: null,
  };
}
