// Consecutive-failure tracking for self-hosted meeting chunks (main process, CommonJS).
//
// A self-hosted server going away mid-meeting must not end the meeting: chunks are
// dropped quietly. But dropping them *silently* forever is worse — the user sees a
// meeting that has stopped producing transcript with no explanation. This emits
// exactly one warning once failures cross the threshold, then stays quiet until a
// success resets it.

const DEFAULT_FAILURE_THRESHOLD = 3;

function createFailureTracker({ threshold = DEFAULT_FAILURE_THRESHOLD } = {}) {
  let consecutiveFailures = 0;
  let warned = false;

  return {
    /**
     * @returns {boolean} true exactly once per outage, when the threshold is crossed.
     */
    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= threshold && !warned) {
        warned = true;
        return true;
      }
      return false;
    },

    /** A successful chunk ends the outage and re-arms the warning. */
    recordSuccess() {
      consecutiveFailures = 0;
      warned = false;
    },

    getConsecutiveFailures() {
      return consecutiveFailures;
    },

    hasWarned() {
      return warned;
    },
  };
}

module.exports = { createFailureTracker, DEFAULT_FAILURE_THRESHOLD };
