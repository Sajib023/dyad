// Retired: the Dyad Pro trial no longer exists (BYOK-only, opencode-style).
// Always reports "not a trial" so trial-gated UI stays hidden. Kept as a
// hook so call sites compile unchanged.
export function useTrialModelRestriction() {
  return {
    isTrial: false,
    isLoadingTrialStatus: false,
  };
}
