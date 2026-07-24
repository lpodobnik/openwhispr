const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/windowsMicSessionDetector.js");

const ROOT =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

// Captured verbatim from `reg query <key> /s` on Windows 11 23H2 (2026-07-24),
// with the two active (0x0) sessions substituted in.
const FIXTURE = [
  `${ROOT}`,
  "    Value    REG_SZ    Allow",
  "",
  `${ROOT}\\Microsoft.BioEnrollment_cw5n1h2txyewy`,
  "",
  `${ROOT}\\Microsoft.GamingApp_8wekyb3d8bbwe`,
  "    Value    REG_SZ    Allow",
  "",
  `${ROOT}\\MSTeams_8wekyb3d8bbwe`,
  "    Value    REG_SZ    Allow",
  "    LastUsedTimeStart    REG_QWORD    0x1dd1a92d660581e",
  "    LastUsedTimeStop    REG_QWORD    0x0",
  "",
  `${ROOT}\\Microsoft.ScreenSketch_8wekyb3d8bbwe`,
  "    Value    REG_SZ    Allow",
  "    LastUsedTimeStart    REG_QWORD    0x1dd0fa4a94b9f9f",
  "    LastUsedTimeStop    REG_QWORD    0x1dd0fa4ac410c49",
  "",
  `${ROOT}\\NonPackaged`,
  "    Value    REG_SZ    Allow",
  "",
  `${ROOT}\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe`,
  "    LastUsedTimeStart    REG_QWORD    0x1dd0f8b4e1b8362",
  "    LastUsedTimeStop    REG_QWORD    0x1dd0f8b4f938d46",
  "",
  `${ROOT}\\NonPackaged\\C:#Program Files#OpenWhispr#OpenWhispr.exe`,
  "    LastUsedTimeStart    REG_QWORD    0x1dd1a9056bfa390",
  "    LastUsedTimeStop    REG_QWORD    0x0",
  "",
  `${ROOT}\\NonPackaged\\C:#Users#lpodobnik#AppData#Local#CiscoSparkLauncher#CiscoCollabHost.exe`,
  "    LastUsedTimeStart    REG_QWORD    0x1dcbd2024ac6221",
  "    LastUsedTimeStop    REG_QWORD    0x1dcbd294ce85d4d",
  "",
  // Stop written for a previous session, then a newer Start: the app crashed
  // mid-capture and is capturing again. Stop < Start, so it is live.
  `${ROOT}\\Restarted_pkg`,
  "    LastUsedTimeStart    REG_QWORD    0x1dd1a92d660581e",
  "    LastUsedTimeStop    REG_QWORD    0x1dcbd294ce85d4d",
  "",
  // Start recorded but no Stop line at all — no evidence of a live session.
  `${ROOT}\\NoStop_pkg`,
  "    LastUsedTimeStart    REG_QWORD    0x1dcbd2024ac6221",
  "",
  `${ROOT}\\NonPackaged\\C:#Users#lpodobnik#AppData#Roaming#Zoom#bin#Zoom.exe`,
  "    LastUsedTimeStart    REG_QWORD    0x1dcafd56f2689ef",
  "    LastUsedTimeStop    REG_QWORD    0x1dcafd7cd401080",
  "",
  "End of search: 9 match(es) found.",
].join("\n");

const byIdentity = (sessions, needle) =>
  sessions.find((s) => s.identity.toLowerCase().includes(needle.toLowerCase()));

test("a packaged app with LastUsedTimeStop 0x0 is active", async () => {
  const { parseMicSessions } = await load();
  const teams = byIdentity(parseMicSessions(FIXTURE), "MSTeams_8wekyb3d8bbwe");
  assert.equal(teams.active, true);
  assert.equal(teams.packaged, true);
});

test("a NonPackaged app with a non-zero LastUsedTimeStop is not active", async () => {
  const { parseMicSessions } = await load();
  const zoom = byIdentity(parseMicSessions(FIXTURE), "Zoom.exe");
  assert.equal(zoom.active, false);
  assert.equal(zoom.packaged, false);
});

// Fail closed: a zeroed LastUsedTimeStop is the only live-verified "capturing now"
// signal, so anything we cannot read must degrade to the exe-name scan rather than
// pin the mic signal permanently true.
test("LastUsedTimeStart without any LastUsedTimeStop is NOT active", async () => {
  const { parseMicSessions } = await load();
  assert.equal(byIdentity(parseMicSessions(FIXTURE), "NoStop_pkg").active, false);
});

test("a LastUsedTimeStop predating its LastUsedTimeStart is active", async () => {
  const { parseMicSessions } = await load();
  assert.equal(byIdentity(parseMicSessions(FIXTURE), "Restarted_pkg").active, true);
});

test("a zeroed LastUsedTimeStart is not a live session", async () => {
  const { parseMicSessions } = await load();
  const text = [
    `${ROOT}\\Zeroed_pkg`,
    "    LastUsedTimeStart    REG_QWORD    0x0",
    "    LastUsedTimeStop    REG_QWORD    0x0",
  ].join("\n");
  assert.equal(parseMicSessions(text)[0].active, false);
});

test("an unreadable LastUsedTimeStop is not treated as active", async () => {
  const { parseMicSessions } = await load();
  const text = [
    `${ROOT}\\Garbled_pkg`,
    "    LastUsedTimeStart    REG_QWORD    0x1dd1a92d660581e",
    "    LastUsedTimeStop    REG_QWORD    (0x0)",
  ].join("\n");
  assert.equal(parseMicSessions(text)[0].active, false);
});

test("subkeys with no values or consent only are never active", async () => {
  const { parseMicSessions } = await load();
  const sessions = parseMicSessions(FIXTURE);
  assert.equal(byIdentity(sessions, "Microsoft.BioEnrollment").active, false);
  assert.equal(byIdentity(sessions, "Microsoft.GamingApp").active, false);
});

test("the root key and the bare NonPackaged container are not identities", async () => {
  const { parseMicSessions } = await load();
  const identities = parseMicSessions(FIXTURE).map((s) => s.identity.toLowerCase());
  assert.equal(identities.includes(""), false);
  assert.equal(identities.includes("nonpackaged"), false);
  assert.equal(
    identities.some((i) => i.startsWith("nonpackaged\\")),
    true
  );
});

test("FILETIMEs beyond Number.MAX_SAFE_INTEGER compare exactly", async () => {
  const { parseMicSessions } = await load();
  const ended = "0x1dd1a9a5ec9bcf2";
  assert.ok(Number(ended) > Number.MAX_SAFE_INTEGER, "fixture value must exceed the safe range");

  const text = [
    `${ROOT}\\Big_pkg`,
    `    LastUsedTimeStart    REG_QWORD    0x1dd1a92d660581e`,
    `    LastUsedTimeStop    REG_QWORD    ${ended}`,
    "",
    `${ROOT}\\Padded_pkg`,
    "    LastUsedTimeStart    REG_QWORD    0x1dd1a92d660581e",
    "    LastUsedTimeStop    REG_QWORD    0x0000000000000000",
  ].join("\n");

  const sessions = parseMicSessions(text);
  assert.equal(byIdentity(sessions, "Big_pkg").active, false);
  assert.equal(byIdentity(sessions, "Padded_pkg").active, true);
});

test("CRLF output parses identically to LF", async () => {
  const { parseMicSessions } = await load();
  const lf = parseMicSessions(FIXTURE);
  const crlf = parseMicSessions(FIXTURE.replace(/\n/g, "\r\n"));
  assert.deepEqual(crlf, lf);
});

test("empty or unrecognised output yields no identities", async () => {
  const { parseMicSessions } = await load();
  assert.deepEqual(parseMicSessions(""), []);
  assert.deepEqual(parseMicSessions("   \n  \n"), []);
  assert.deepEqual(parseMicSessions("ERROR: The system was unable to find the key."), []);
  assert.deepEqual(parseMicSessions(undefined), []);
});

test("OpenWhispr's own session is recognised as self", async () => {
  const { isSelfIdentity } = await load();
  assert.equal(
    isSelfIdentity("NonPackaged\\C:#Program Files#OpenWhispr#OpenWhispr.exe"),
    true,
    "packaged install path"
  );
  assert.equal(
    isSelfIdentity(`NonPackaged\\${process.execPath.replace(/\\/g, "#")}`),
    true,
    "identity derived from the running executable"
  );
  assert.equal(isSelfIdentity("MSTeams_8wekyb3d8bbwe"), false);
  assert.equal(isSelfIdentity("NonPackaged\\C:#Users#x#AppData#Roaming#Zoom#bin#Zoom.exe"), false);
});

test("identities map to the known meeting apps", async () => {
  const { mapIdentityToProcessKey } = await load();
  assert.deepEqual(mapIdentityToProcessKey("MSTeams_8wekyb3d8bbwe"), {
    processKey: "teams",
    appName: "Microsoft Teams",
  });
  assert.deepEqual(
    mapIdentityToProcessKey("NonPackaged\\C:#Users#x#AppData#Roaming#Zoom#bin#Zoom.exe"),
    { processKey: "zoom", appName: "Zoom" }
  );
  // Webex registers under Cisco branding, never the string "webex".
  assert.deepEqual(
    mapIdentityToProcessKey(
      "NonPackaged\\C:#Users#x#AppData#Local#CiscoSparkLauncher#CiscoCollabHost.exe"
    ),
    { processKey: "webex", appName: "Webex" }
  );
  assert.deepEqual(mapIdentityToProcessKey("MicrosoftTeams_8wekyb3d8bbwe"), {
    processKey: "teams",
    appName: "Microsoft Teams",
  });
  assert.equal(
    mapIdentityToProcessKey("NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe"),
    null,
    "a browser is mic evidence but not a named meeting app"
  );
  assert.equal(mapIdentityToProcessKey(undefined), null);
});

// The identity is a full path, so an unanchored substring match would brand every
// app under a user or vendor folder whose name merely contains "zoom".
test("mapping anchors on the executable leaf, not the whole path", async () => {
  const { mapIdentityToProcessKey } = await load();
  assert.equal(
    mapIdentityToProcessKey(
      "NonPackaged\\C:#Users#zoom#AppData#Local#Google#Chrome#Application#chrome.exe"
    ),
    null,
    "a user folder named zoom must not make Chrome a Zoom meeting"
  );
  assert.equal(
    mapIdentityToProcessKey("NonPackaged\\C:#Program Files#ZoomInfo#zi.exe"),
    null,
    "ZoomInfo is a different product"
  );
});

test("key lines are matched case-insensitively", async () => {
  const { parseMicSessions } = await load();
  const text = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\Microphone\\MSTeams_8wekyb3d8bbwe",
    "    LastUsedTimeStart    REG_QWORD    0x1dd1a92d660581e",
    "    LastUsedTimeStop    REG_QWORD    0x0",
  ].join("\n");
  const sessions = parseMicSessions(text);
  assert.equal(sessions.length, 1, "casing drift must not silently disable parsing");
  assert.equal(sessions[0].active, true);
});

test("sidecar binaries in our own install directory count as self", async () => {
  const { isSelfIdentity } = await load();
  const path = require("path");
  const dir = path.dirname(process.execPath).replace(/\\/g, "#");
  assert.equal(
    isSelfIdentity(`NonPackaged\\${dir}#some-bundled-helper.exe`),
    true,
    "a helper we ship must not look like a third-party mic user"
  );
});

// getActiveMicSessions shells out to `reg`, so the runner is injectable — these
// cover the ok/fallback contract both detectors depend on, on every platform.
const withRunner = async (stdoutOrError, extra = {}) => {
  const { getActiveMicSessions, resetCache } = await load();
  resetCache();
  const runQuery =
    stdoutOrError instanceof Error
      ? () => Promise.reject(stdoutOrError)
      : () => Promise.resolve(stdoutOrError);
  return getActiveMicSessions({ runQuery, useCache: false, ...extra });
};

test("getActiveMicSessions reports active non-self sessions", async (t) => {
  if (process.platform !== "win32") return t.skip("win32-only code path");
  const result = await withRunner(FIXTURE);
  assert.equal(result.ok, true);
  const identities = result.sessions.map((s) => s.identity);
  assert.ok(identities.includes("MSTeams_8wekyb3d8bbwe"));
  assert.equal(
    identities.some((i) => i.toLowerCase().includes("openwhispr")),
    false,
    "our own capture must never be reported"
  );
});

test("a failed reg query reports unusable, never an idle mic", async (t) => {
  if (process.platform !== "win32") return t.skip("win32-only code path");
  assert.deepEqual(await withRunner(new Error("ENOBUFS")), { ok: false, sessions: [] });
});

test("output with no usage timestamps reports unusable, never an idle mic", async (t) => {
  if (process.platform !== "win32") return t.skip("win32-only code path");
  const consentOnly = [`${ROOT}\\Some_pkg`, "    Value    REG_SZ    Allow"].join("\n");
  assert.deepEqual(await withRunner(consentOnly), { ok: false, sessions: [] });
  assert.deepEqual(await withRunner(""), { ok: false, sessions: [] });
});

test("results are cached briefly so both detectors share one shell-out", async (t) => {
  if (process.platform !== "win32") return t.skip("win32-only code path");
  const { getActiveMicSessions, resetCache } = await load();
  resetCache();
  let calls = 0;
  const runQuery = () => {
    calls += 1;
    return Promise.resolve(FIXTURE);
  };
  await getActiveMicSessions({ runQuery, nowMs: 1000 });
  await getActiveMicSessions({ runQuery, nowMs: 2000 });
  assert.equal(calls, 1, "second call within the TTL must reuse the cache");
  await getActiveMicSessions({ runQuery, nowMs: 9000 });
  assert.equal(calls, 2, "a call past the TTL must re-query");
  resetCache();
});

test("getActiveMicSessions reports unusable off Windows rather than idle", async (t) => {
  if (process.platform === "win32") return t.skip("non-win32 guard only");
  const { getActiveMicSessions } = await load();
  assert.deepEqual(await getActiveMicSessions(), { ok: false, sessions: [] });
});
