const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSelfHostedTranscriptionUrl,
  transcribeSelfHostedChunk,
} = require("../../src/helpers/selfHostedMeetingChunk");
const { createFailureTracker } = require("../../src/helpers/selfHostedMeetingFailureTracker");

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

test("assumes http:// for a scheme-less host:port so it does not parse as a scheme", () => {
  const result = normalizeSelfHostedTranscriptionUrl("192.168.1.50:8000/v1/audio/transcriptions");
  assert.equal(result.valid, true);
  assert.equal(result.endpoint, "http://192.168.1.50:8000/v1/audio/transcriptions");
});

test("round-trips a full transcriptions URL without duplicating the suffix", () => {
  const result = normalizeSelfHostedTranscriptionUrl("http://192.168.1.50:8000/v1/audio/transcriptions");
  assert.equal(result.endpoint, "http://192.168.1.50:8000/v1/audio/transcriptions");
});

test("appends /v1 when the user pastes a bare origin", () => {
  const result = normalizeSelfHostedTranscriptionUrl("http://localhost:8000");
  assert.equal(result.endpoint, "http://localhost:8000/v1/audio/transcriptions");
});

test("tolerates trailing slashes", () => {
  const result = normalizeSelfHostedTranscriptionUrl("http://localhost:8000/v1/");
  assert.equal(result.endpoint, "http://localhost:8000/v1/audio/transcriptions");
});

test("accepts a .local hostname over plain http", () => {
  const result = normalizeSelfHostedTranscriptionUrl("whisper.local:8000/v1/audio/transcriptions");
  assert.equal(result.valid, true);
  assert.equal(result.endpoint, "http://whisper.local:8000/v1/audio/transcriptions");
});

test("accepts any host over https", () => {
  const result = normalizeSelfHostedTranscriptionUrl("https://asr.example.com/v1");
  assert.equal(result.valid, true);
  assert.equal(result.endpoint, "https://asr.example.com/v1/audio/transcriptions");
});

// ---------------------------------------------------------------------------
// Fail closed — these must never resolve to a usable endpoint, because the
// caller would otherwise fall through to cloud realtime (the bug being fixed).
// ---------------------------------------------------------------------------

test("rejects an empty URL", () => {
  for (const input of ["", "   ", null, undefined]) {
    const result = normalizeSelfHostedTranscriptionUrl(input);
    assert.equal(result.valid, false);
    assert.equal(result.endpoint, null);
    assert.equal(result.reason, "empty");
  }
});

test("rejects plaintext http to a public host", () => {
  const result = normalizeSelfHostedTranscriptionUrl("http://asr.example.com/v1");
  assert.equal(result.valid, false);
  assert.equal(result.endpoint, null);
  assert.equal(result.reason, "insecure");
});

// Documents a real-world gotcha: an internal domain that is not RFC1918 and does
// not end in .local is treated as public, so plain http is refused. Reaching such
// a server requires https, its LAN IP, or a .local name.
test("rejects a private-sounding but non-.local internal domain over http", () => {
  const result = normalizeSelfHostedTranscriptionUrl(
    "sandcrawler.lan.croz.net:8000/v1/audio/transcriptions"
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "insecure");
});

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

const wav = Buffer.from([0x52, 0x49, 0x46, 0x46]);

const okResponse = (text = "bok svijete") => ({
  ok: true,
  status: 200,
  json: async () => ({ text }),
});

const captureFetch = (response = okResponse()) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { calls, fetchImpl };
};

test("posts multipart fields including the language hint", async () => {
  const { calls, fetchImpl } = captureFetch();

  const result = await transcribeSelfHostedChunk(wav, {
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    model: "whisper-large-v3-turbo",
    language: "hr",
    fetchImpl,
  });

  assert.equal(result.success, true);
  assert.equal(result.text, "bok svijete");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:8000/v1/audio/transcriptions");
  assert.equal(calls[0].init.method, "POST");

  const body = calls[0].init.body;
  assert.equal(body.get("model"), "whisper-large-v3-turbo");
  assert.equal(body.get("language"), "hr");
  assert.equal(body.get("response_format"), "json");
  assert.ok(body.get("file"), "expected a file part");
});

test("omits the language field when set to auto", async () => {
  const { calls, fetchImpl } = captureFetch();

  await transcribeSelfHostedChunk(wav, {
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    language: "auto",
    fetchImpl,
  });

  assert.equal(calls[0].init.body.get("language"), null);
});

test("sends no Authorization header when the LAN server has no key", async () => {
  const { calls, fetchImpl } = captureFetch();

  await transcribeSelfHostedChunk(wav, {
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    fetchImpl,
  });

  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("sends a bearer token when an api key is configured", async () => {
  const { calls, fetchImpl } = captureFetch();

  await transcribeSelfHostedChunk(wav, {
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    apiKey: "  secret  ",
    fetchImpl,
  });

  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
});

// ---------------------------------------------------------------------------
// Per-chunk error tolerance — never throw, so a meeting cannot be aborted.
// ---------------------------------------------------------------------------

test("resolves unsuccessfully on a non-2xx response instead of throwing", async () => {
  const { fetchImpl } = captureFetch({
    ok: false,
    status: 500,
    text: async () => "boom",
  });

  const result = await transcribeSelfHostedChunk(wav, {
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    fetchImpl,
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "http-500");
  assert.equal(result.text, "");
});

test("resolves unsuccessfully when the request times out", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  const result = await transcribeSelfHostedChunk(wav, {
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    timeoutMs: 10,
    fetchImpl,
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "timeout");
});

test("resolves unsuccessfully when the transport throws", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };

  const result = await transcribeSelfHostedChunk(wav, {
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    fetchImpl,
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "network");
});

test("resolves unsuccessfully when no endpoint was resolved", async () => {
  const result = await transcribeSelfHostedChunk(wav, { endpoint: null });
  assert.equal(result.success, false);
  assert.equal(result.reason, "no-endpoint");
});

// ---------------------------------------------------------------------------
// Consecutive-failure warning
// ---------------------------------------------------------------------------

test("warns exactly once when failures reach the threshold", () => {
  const tracker = createFailureTracker({ threshold: 3 });

  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), true, "third failure crosses the threshold");
  assert.equal(tracker.recordFailure(), false, "stays quiet afterwards");
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.getConsecutiveFailures(), 5);
});

test("a success resets the counter and re-arms the warning", () => {
  const tracker = createFailureTracker({ threshold: 3 });

  tracker.recordFailure();
  tracker.recordFailure();
  tracker.recordSuccess();
  assert.equal(tracker.getConsecutiveFailures(), 0);

  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), true, "warns again after recovering");
});

test("intermittent failures below the threshold never warn", () => {
  const tracker = createFailureTracker({ threshold: 3 });

  for (let i = 0; i < 10; i += 1) {
    assert.equal(tracker.recordFailure(), false);
    assert.equal(tracker.recordFailure(), false);
    tracker.recordSuccess();
  }

  assert.equal(tracker.hasWarned(), false);
});
