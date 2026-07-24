// Self-hosted meeting chunk transcription (main process, CommonJS).
//
// The meeting "local" mode is batch, not streaming: every 5s a WAV chunk is
// drained per stream and handed to a provider. This module is the self-hosted
// provider — it POSTs the chunk to any OpenAI-compatible
// `/v1/audio/transcriptions` endpoint.
//
// Why the duplicated URL/security logic: dictation's equivalents live in
// `src/config/constants.ts` (normalizeBaseUrl) and `src/utils/urlUtils.ts`
// (isSecureEndpoint) — both ESM/TypeScript, bundled by Vite for the renderer and
// not requireable from the main process. The semantics are mirrored here
// deliberately; keep them in sync if the originals change.

const debugLogger = require("./debugLogger");

const TRANSCRIPTION_PATH = "/audio/transcriptions";
const DEFAULT_TIMEOUT_MS = 15000;

// Mirrors normalizeBaseUrl() in src/config/constants.ts — trims the API endpoint
// suffix so a pasted full URL and a bare origin both collapse to the same base.
const SUFFIX_REPLACEMENTS = [
  [/\/v1\/audio\/transcriptions$/i, "/v1"],
  [/\/audio\/transcriptions$/i, ""],
  [/\/v1\/audio\/translations$/i, "/v1"],
  [/\/audio\/translations$/i, ""],
];

// Mirrors isPrivateHost() in src/utils/urlUtils.ts.
function isPrivateHost(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0" || h.startsWith("127.")) return true;
  if (h === "::1") return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  if (h.startsWith("172.")) {
    const octet = parseInt(h.split(".")[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(h)) return true;
  if (h.startsWith("169.254.")) return true;

  const isIPv6 = h.includes(":");
  if (isIPv6 && (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd"))) return true;
  if (h.endsWith(".local")) return true;

  return false;
}

// Mirrors isSecureEndpoint() in src/utils/urlUtils.ts: plaintext HTTP is only
// tolerated on a private host.
function isSecureEndpoint(parsed) {
  return parsed.protocol === "https:" || isPrivateHost(parsed.hostname);
}

/**
 * Resolve a user-entered self-hosted URL into a concrete transcription endpoint.
 *
 * Fails closed: callers must treat `valid: false` as "do not transcribe", never
 * as "fall back to the cloud". Silent cloud fallback is the bug this module exists
 * to remove.
 *
 * @returns {{valid: boolean, endpoint: string|null, reason: string|null}}
 */
function normalizeSelfHostedTranscriptionUrl(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { valid: false, endpoint: null, reason: "empty" };
  }

  // A bare `host:port/path` parses as <scheme=host:> with an empty hostname, so
  // assume http:// when no scheme is present. The security check below still
  // applies, so this cannot smuggle in a public plaintext host.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { valid: false, endpoint: null, reason: "unparseable" };
  }

  if (!parsed.hostname) {
    return { valid: false, endpoint: null, reason: "unparseable" };
  }

  if (!isSecureEndpoint(parsed)) {
    return { valid: false, endpoint: null, reason: "insecure" };
  }

  let path = parsed.pathname.replace(/\/+$/, "");
  for (const [pattern, replacement] of SUFFIX_REPLACEMENTS) {
    if (pattern.test(path)) {
      path = path.replace(pattern, replacement).replace(/\/+$/, "");
      break;
    }
  }

  // OpenAI-compatible servers serve under /v1 even when the user pastes a bare
  // origin (mirrors ensureV1Suffix in src/config/constants.ts).
  if (!/\/v1$/i.test(path)) {
    path = `${path}/v1`;
  }

  return { valid: true, endpoint: `${parsed.origin}${path}${TRANSCRIPTION_PATH}`, reason: null };
}

/**
 * POST one WAV chunk to a self-hosted OpenAI-compatible transcription endpoint.
 *
 * Resolves `{success: false}` rather than throwing on transport/HTTP errors so a
 * single bad chunk can never abort a live meeting.
 *
 * @returns {Promise<{success: boolean, text: string, reason?: string}>}
 */
async function transcribeSelfHostedChunk(
  wav,
  { endpoint, model, language, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}
) {
  if (!endpoint) {
    return { success: false, text: "", reason: "no-endpoint" };
  }

  const formData = new FormData();
  formData.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  if (model) {
    formData.append("model", model);
  }
  // "auto" is the app's sentinel for detect-per-chunk; omitting the field lets
  // the server decide, which is the same thing.
  if (language && language !== "auto") {
    formData.append("language", language);
  }
  formData.append("response_format", "json");

  const headers = {};
  // LAN servers frequently have no auth at all — only send a bearer when set.
  if (apiKey && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
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
    const aborted = error?.name === "AbortError";
    debugLogger.warn("Self-hosted meeting chunk failed", {
      error: error?.message,
      timedOut: aborted,
    });
    return { success: false, text: "", reason: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  normalizeSelfHostedTranscriptionUrl,
  transcribeSelfHostedChunk,
  isPrivateHost,
  DEFAULT_TIMEOUT_MS,
};
