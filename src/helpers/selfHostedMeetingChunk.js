// Self-hosted Note Recording transcription (main process, CommonJS).
//
// Note Recording's local mode is batch, not streaming: every few seconds a WAV
// chunk is drained per stream and handed to a provider. This module is the
// self-hosted provider — it POSTs the chunk to the OpenAI-compatible
// `/v1/audio/transcriptions` endpoint that resolveTranscriptionRoute() derives
// from the configured server, the same endpoint dictation's self-hosted mode uses.
// A self-hosted server therefore only needs batch transcription, not streaming.

const debugLogger = require("./debugLogger");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * POST one WAV chunk to a self-hosted transcription endpoint.
 *
 * Resolves `{ success: false }` rather than throwing on transport or HTTP errors,
 * so one bad chunk (or a server that went away) can never abort a live meeting.
 *
 * @returns {Promise<{ success: boolean, text: string, reason?: string }>}
 */
async function transcribeSelfHostedChunk(
  wav,
  { endpoint, model, language, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}
) {
  if (!endpoint) {
    return { success: false, text: "", reason: "no-endpoint" };
  }

  const formData = new FormData();
  formData.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  if (model) {
    formData.append("model", model);
  }
  // "auto" means detect per chunk; omitting the field lets the server do that.
  if (language && language !== "auto") {
    formData.append("language", language);
  }
  formData.append("response_format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // No API key: self-hosted servers are keyless by convention, matching the
    // `auth: none` the dictation route uses for this mode.
    const response = await fetchImpl(endpoint, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      debugLogger.warn("Self-hosted meeting chunk rejected", {
        status: response.status,
        detail: detail.slice(0, 200),
      });
      return { success: false, text: "", reason: `http-${response.status}` };
    }

    const data = await response.json();
    return { success: true, text: typeof data?.text === "string" ? data.text : "" };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    debugLogger.warn("Self-hosted meeting chunk failed", { error: error?.message, timedOut });
    return { success: false, text: "", reason: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tracks consecutive chunk failures. A dead server drops chunks but must not end
 * the meeting; dropping them silently forever is worse, though, so this reports
 * true exactly once per outage, and a success re-arms it.
 */
function createFailureTracker({ threshold = DEFAULT_FAILURE_THRESHOLD } = {}) {
  let consecutiveFailures = 0;
  let warned = false;

  return {
    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= threshold && !warned) {
        warned = true;
        return true;
      }
      return false;
    },
    recordSuccess() {
      consecutiveFailures = 0;
      warned = false;
    },
  };
}

module.exports = {
  transcribeSelfHostedChunk,
  createFailureTracker,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_FAILURE_THRESHOLD,
};
