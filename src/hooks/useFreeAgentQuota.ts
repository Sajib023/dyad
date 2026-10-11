import type { FreeAgentQuotaStatus } from "@/ipc/types";
import { FREE_AGENT_QUOTA_LIMIT } from "@/lib/free_agent_quota_limit";

// Retired: the Basic Agent per-window quota no longer exists (BYOK-only,
// opencode-style — every request uses the user's own key). This stub keeps
// the hook's shape so all call sites compile and behave as "unlimited".
const UNLIMITED_STATUS: FreeAgentQuotaStatus = {
  messagesUsed: 0,
  messagesLimit: FREE_AGENT_QUOTA_LIMIT,
  isQuotaExceeded: false,
  windowStartTime: null,
  resetTime: null,
  hoursUntilReset: null,
};

/**
 * Hook to get the free agent quota status for non-Pro users.
 *
 * Retired: always reports a fresh, never-exceeded quota.
 */
export function useFreeAgentQuota() {
  return {
    quotaStatus: UNLIMITED_STATUS,
    isLoading: false,
    error: null,
    invalidateQuota: () => {},
    // Convenience properties for easier consumption
    isQuotaExceeded: false,
    messagesUsed: 0,
    messagesLimit: FREE_AGENT_QUOTA_LIMIT,
    messagesRemaining: FREE_AGENT_QUOTA_LIMIT,
    hoursUntilReset: null,
    resetTime: null,
  };
}
