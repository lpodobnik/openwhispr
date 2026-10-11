const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// debugLogger needs Electron's `app`; the module under test only warns through it.
const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "./debugLogger") return { warn() {}, debug() {}, info() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  transcribeSelfHostedChunk,
  createFailureTracker,
} = require("../../src/helpers/selfHostedMeetingChunk");
Module._load = originalLoad;

const ENDPOINT = "http://192.168.1.20:8178/v1/audio/transcriptions";
const wav = Buffer.from([0x52, 0x49, 0x46, 0x46]);

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test("posts the chunk with model and language, and no auth header", async () => {
  let call;
  const result = await transcribeSelfHostedChunk(wav, {
    endpoint: ENDPOINT,
    model: "whisper-large-v3-turbo",
    language: "de",
    fetchImpl: async (url, init) => {
      call = { url, init };
      return jsonResponse({ text: "Guten Morgen" });
    },
  });

  assert.deepEqual(result, { success: true, text: "Guten Morgen" });
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers, undefined);
  assert.equal(call.init.body.get("model"), "whisper-large-v3-turbo");
  assert.equal(call.init.body.get("language"), "de");
  assert.equal(call.init.body.get("response_format"), "json");
  assert.ok(call.init.body.get("file"));
});

test("omits model when unset and language when auto-detecting", async () => {
  let body;
  await transcribeSelfHostedChunk(wav, {
    endpoint: ENDPOINT,
    model: null,
    language: "auto",
    fetchImpl: async (_url, init) => {
      body = init.body;
      return jsonResponse({ text: "" });
    },
  });

  assert.equal(body.has("model"), false);
  assert.equal(body.has("language"), false);
});

test("never throws: HTTP errors, network errors and timeouts resolve as failures", async () => {
  const httpError = await transcribeSelfHostedChunk(wav, {
    endpoint: ENDPOINT,
    fetchImpl: async () => jsonResponse({ error: "boom" }, { ok: false, status: 503 }),
  });
  assert.deepEqual(httpError, { success: false, text: "", reason: "http-503" });

  const networkError = await transcribeSelfHostedChunk(wav, {
    endpoint: ENDPOINT,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(networkError, { success: false, text: "", reason: "network" });

  const timedOut = await transcribeSelfHostedChunk(wav, {
    endpoint: ENDPOINT,
    timeoutMs: 10,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  assert.deepEqual(timedOut, { success: false, text: "", reason: "timeout" });
});

test("refuses to send without an endpoint", async () => {
  let called = false;
  const result = await transcribeSelfHostedChunk(wav, {
    endpoint: null,
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ text: "x" });
    },
  });

  assert.deepEqual(result, { success: false, text: "", reason: "no-endpoint" });
  assert.equal(called, false);
});

test("failure tracker warns once per outage and re-arms after a success", () => {
  const tracker = createFailureTracker({ threshold: 3 });

  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), true);
  assert.equal(tracker.recordFailure(), false);

  tracker.recordSuccess();
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), true);
});
