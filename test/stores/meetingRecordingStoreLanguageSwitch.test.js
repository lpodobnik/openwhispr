const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// The in-meeting language switch changes only the running recording: main is
// asked to switch, a refusal restores the previous choice, and a stop hands the
// next recording back to the Settings language.

const START_ARGS = {
  noteId: 11,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ setLanguageResult }) {
  const languageCalls = [];
  const noopListener = () => () => {};
  const notes = new Map([[11, { id: 11, transcript: "", deleted_at: null }]]);
  return {
    languageCalls,
    api: {
      checkSystemAudioAccess: async () => ({
        granted: true,
        status: "granted",
        mode: "native",
        strategy: "native",
      }),
      meetingTranscriptionStart: async () => ({
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "native",
      }),
      meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
      meetingTranscriptionStop: async () => ({ success: true }),
      meetingTranscriptionSetLanguage: async (language) => {
        languageCalls.push(language);
        return setLanguageResult();
      },
      meetingTranscriptionSend: () => {},
      getNote: async (id) => notes.get(id) ?? null,
      updateNote: async () => ({ success: true }),
      onMeetingTranscriptionSegment: noopListener,
      onMeetingSpeakerIdentified: noopListener,
      onMeetingSpeakersMerged: noopListener,
      onMeetingSessionSpeakerConfigUpdated: noopListener,
      onMeetingTranscriptionError: noopListener,
      onMeetingTranscriptionFatalError: noopListener,
      onMeetingSystemAudioSilent: noopListener,
      onMeetingDiarizationComplete: noopListener,
    },
  };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-language-switch-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

test("switching while recording asks main for the base language code", async (t) => {
  const { api, languageCalls } = createElectronAPI({
    setLanguageResult: () => ({ success: true }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(await store.setMeetingSessionLanguage("en-US"), true);

  assert.deepEqual(languageCalls, ["en"]);
  assert.equal(store.useMeetingRecordingStore.getState().sessionLanguage, "en-US");
});

test("auto-detect is sent as no language", async (t) => {
  const { api, languageCalls } = createElectronAPI({
    setLanguageResult: () => ({ success: true }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(await store.setMeetingSessionLanguage("auto"), true);

  assert.deepEqual(languageCalls, [undefined]);
});

test("a switch main refuses restores the previous language", async (t) => {
  let succeed = true;
  const { api } = createElectronAPI({
    setLanguageResult: () => (succeed ? { success: true } : { success: false, error: "nope" }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(await store.setMeetingSessionLanguage("hr"), true);
  succeed = false;
  assert.equal(await store.setMeetingSessionLanguage("en"), false);

  assert.equal(store.useMeetingRecordingStore.getState().sessionLanguage, "hr");
});

test("a switch that rejects restores the previous language", async (t) => {
  const { api } = createElectronAPI({
    setLanguageResult: () => {
      throw new Error("ipc channel closed");
    },
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(await store.setMeetingSessionLanguage("en"), false);

  assert.equal(store.useMeetingRecordingStore.getState().sessionLanguage, null);
});

test("stopping hands the next recording back to the Settings language", async (t) => {
  const { api } = createElectronAPI({ setLanguageResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  await store.setMeetingSessionLanguage("en");
  await store.stopRecording();

  assert.equal(store.useMeetingRecordingStore.getState().sessionLanguage, null);
});
