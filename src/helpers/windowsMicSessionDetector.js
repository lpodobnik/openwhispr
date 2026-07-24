const { exec } = require("child_process");
const path = require("path");
const { promisify } = require("util");

const execAsync = promisify(exec);

// debugLogger pulls in electron at load. Require it lazily so the pure parsing
// helpers below stay importable — and unit-testable — outside the app.
function log(level, message, meta) {
  try {
    require("./debugLogger")[level](message, meta, "meeting");
  } catch {
    // logging is best-effort
  }
}

// Windows records every microphone capture session here — it is what the OS
// mic-in-use indicator reads. HKCU, no elevation required.
const MIC_CONSENT_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

// A long-lived profile accumulates one NonPackaged subkey per executable that has
// ever touched the mic, so do not rely on exec's 1MB default buffer.
const EXEC_OPTS = {
  timeout: 5000,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
};

// Both detectors poll on their own schedules; this mirrors processListCache so we
// shell out once per burst instead of once per caller.
const CACHE_TTL_MS = 5000;

const KEY_LINE_PREFIX = "hkey_current_user\\";
const SUBKEY_MARKER = "\\consentstore\\microphone";
const NONPACKAGED = "nonpackaged";

// Matched against the identity's trailing segment (the executable leaf, or the
// whole package family name). Anchored, because the identity is a full path —
// an unanchored /zoom/ turns every app under a user named "zoom" into a meeting.
const PROCESS_KEY_PATTERNS = [
  {
    processKey: "teams",
    appName: "Microsoft Teams",
    // MSTeams_* is the current MSIX package; MicrosoftTeams_* is the classic one.
    pattern: /^msteams|^microsoftteams|^ms-teams|^teams\.exe$/,
  },
  { processKey: "zoom", appName: "Zoom", pattern: /^zoom(\.exe)?$|^cpthost\.exe$/ },
  { processKey: "webex", appName: "Webex", pattern: /^webex|^ciscocollabhost\.exe$|^ciscospark/ },
];

let cache = { at: 0, result: null };

function toBigInt(hex) {
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

// Fail CLOSED. The only live-verified "capturing now" signal is a zeroed
// LastUsedTimeStop (confirmed against a real Teams call). A stop that predates
// the current start is also live — that is how a crash-then-restart looks, since
// the stale stop was written for the previous session. Anything else — missing,
// zeroed start, unreadable — is treated as not capturing, so the worst case is
// falling back to the exe-name scan rather than a permanently-true mic signal
// that would prompt the user every cooldown forever.
function isActiveEntry(entry) {
  const start = toBigInt(entry.start);
  if (start === null || start === 0n) return false;
  if (entry.stop === null) return false;
  const stop = toBigInt(entry.stop);
  if (stop === null) return false;
  return stop === 0n || stop < start;
}

/**
 * Parse `reg query <microphone consent key> /s` output.
 * Pure — no registry access — so the format contract is unit-testable.
 *
 * `tracked` marks an entry that carries usage timestamps at all; if nothing in
 * the output is tracked we learned nothing and must not report an idle mic.
 *
 * @param {string} text raw stdout
 * @returns {{identity: string, packaged: boolean, tracked: boolean, active: boolean}[]}
 */
function parseMicSessions(text) {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  const entries = [];
  let current = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const lower = line.toLowerCase();
    if (lower.startsWith(KEY_LINE_PREFIX)) {
      flush();
      // Casing of the echoed key path is not guaranteed, so locate it case-insensitively.
      const markerIdx = lower.indexOf(SUBKEY_MARKER);
      if (markerIdx === -1) continue;

      const identity = line.slice(markerIdx + SUBKEY_MARKER.length).replace(/^\\/, "");
      // The root key and the bare NonPackaged container are not apps.
      if (identity.length === 0 || identity.toLowerCase() === NONPACKAGED) continue;

      current = {
        identity,
        packaged: !identity.toLowerCase().startsWith(`${NONPACKAGED}\\`),
        start: null,
        stop: null,
      };
      continue;
    }

    if (!current) continue;

    const value = line.match(/^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(\S+)$/i);
    if (value) {
      // FILETIMEs exceed Number.MAX_SAFE_INTEGER — keep them as text and compare as BigInt.
      if (value[1].toLowerCase() === "lastusedtimestart") current.start = value[2];
      else current.stop = value[2];
    }
  }
  flush();

  return entries.map((entry) => ({
    identity: entry.identity,
    packaged: entry.packaged,
    tracked: entry.start !== null || entry.stop !== null,
    active: isActiveEntry(entry),
  }));
}

// Our own capture must never look like a meeting, or dictation prompts the user
// about itself. Match the running executable, anything else shipped in the same
// install directory (helper sidecars open capture streams of their own), and the
// product name as a last net for short-path or symlinked spellings.
function toIdentityPath(fsPath) {
  return `${NONPACKAGED}\\${fsPath.replace(/\\/g, "#")}`.toLowerCase();
}

function isSelfIdentity(identity) {
  const lower = String(identity).toLowerCase();
  if (lower.includes("openwhispr")) return true;

  const exe = process.execPath;
  if (typeof exe !== "string" || exe.length === 0) return false;
  if (lower === toIdentityPath(exe)) return true;
  return lower.startsWith(`${toIdentityPath(path.dirname(exe))}#`);
}

// The identity is either a package family name or a '#'-separated executable
// path; in both cases the trailing segment is what identifies the app.
function identityLeaf(identity) {
  const lower = identity.toLowerCase();
  if (!lower.startsWith(`${NONPACKAGED}\\`)) return lower;
  return lower.split("#").pop() || lower;
}

/**
 * Map a registry identity to a known meeting app.
 * @returns {{processKey: string, appName: string} | null}
 */
function mapIdentityToProcessKey(identity) {
  if (typeof identity !== "string" || identity.length === 0) return null;
  const leaf = identityLeaf(identity);
  for (const { processKey, appName, pattern } of PROCESS_KEY_PATTERNS) {
    if (pattern.test(leaf)) return { processKey, appName };
  }
  return null;
}

async function defaultRunQuery() {
  const { stdout } = await execAsync(`reg query "${MIC_CONSENT_KEY}" /s`, EXEC_OPTS);
  return stdout;
}

/**
 * Enumerate microphone sessions that are capturing right now, excluding our own.
 *
 * `ok: false` means the registry told us nothing usable (wrong platform, key
 * absent, reg missing, unreadable or untracked output). Callers must fall back
 * rather than treat it as "nobody is on the mic" — the consent store does not
 * record every mic user, so an empty result is not proof of an idle mic.
 *
 * @returns {Promise<{ok: boolean, sessions: {identity: string, packaged: boolean}[]}>}
 */
async function getActiveMicSessions(options = {}) {
  const { runQuery = defaultRunQuery, nowMs = Date.now(), useCache = true } = options;

  if (process.platform !== "win32") return { ok: false, sessions: [] };
  if (useCache && cache.result && nowMs - cache.at < CACHE_TTL_MS) return cache.result;

  const finish = (result) => {
    if (useCache) cache = { at: nowMs, result };
    return result;
  };

  let stdout;
  try {
    stdout = await runQuery();
  } catch (err) {
    log("debug", "Mic consent registry query failed", { error: err.message });
    return finish({ ok: false, sessions: [] });
  }

  let parsed;
  try {
    parsed = parseMicSessions(stdout);
  } catch (err) {
    log("warn", "Mic consent registry parse failed", { error: err.message });
    return finish({ ok: false, sessions: [] });
  }

  // No identities, or none carrying usage timestamps, means we could not read the
  // ledger — not that the mic is idle. Log it: otherwise a silently disabled
  // feature is indistinguishable from a quiet microphone.
  if (!parsed.some((entry) => entry.tracked)) {
    log("debug", "Mic consent registry produced no usable entries", {
      identities: parsed.length,
    });
    return finish({ ok: false, sessions: [] });
  }

  const sessions = parsed
    .filter((entry) => entry.active && !isSelfIdentity(entry.identity))
    .map(({ identity, packaged }) => ({ identity, packaged }));

  return finish({ ok: true, sessions });
}

function resetCache() {
  cache = { at: 0, result: null };
}

module.exports = {
  MIC_CONSENT_KEY,
  parseMicSessions,
  isSelfIdentity,
  mapIdentityToProcessKey,
  getActiveMicSessions,
  resetCache,
};
