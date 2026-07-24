const EventEmitter = require("events");
const debugLogger = require("./debugLogger");
const processListCache = require("./processListCache");

const POLL_INTERVAL_MS = 30 * 1000;

const BUNDLE_ID_MAP = {
  "us.zoom.xos": "zoom",
  "com.microsoft.teams": "teams",
  "com.microsoft.teams2": "teams",
  "com.cisco.webexmeetingsapp": "webex",
  "com.apple.FaceTime": "facetime",
};

const BUNDLE_APP_NAMES = {
  zoom: "Zoom",
  teams: "Microsoft Teams",
  webex: "Webex",
  facetime: "FaceTime",
};

const MEETING_APPS = {
  win32: [
    { processKey: "zoom", appName: "Zoom", imageName: "cpthost.exe" },
    { processKey: "teams", appName: "Microsoft Teams", imageName: "ms-teams_modulehost.exe" },
    { processKey: "webex", appName: "Webex", imageName: "webexmeetingsapp.exe" },
  ],
  linux: [
    { processKey: "zoom", appName: "Zoom", imageName: "zoom" },
    { processKey: "teams", appName: "Microsoft Teams", imageName: "teams" },
  ],
};

class MeetingProcessDetector extends EventEmitter {
  constructor() {
    super();
    this.pollInterval = null;
    this.detectedProcesses = new Map();
    this.dismissedProcesses = new Set();
    this._polling = false;
    this._subscriptionIds = [];
    // Last successful win32 mic-session read, retained across a failed lookup.
    this._micDerivedKeys = new Set();
  }

  start() {
    if (this.pollInterval || this._subscriptionIds.length > 0) return;

    if (process.platform === "darwin") {
      this._startDarwin();
    } else {
      const apps = MEETING_APPS[process.platform] || [];
      debugLogger.info(
        "Process detector started",
        {
          platform: process.platform,
          appsMonitored: apps.map((a) => a.appName),
          intervalMs: POLL_INTERVAL_MS,
        },
        "meeting"
      );
      this._poll();
      this.pollInterval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    }
  }

  _startDarwin() {
    let systemPreferences;
    try {
      systemPreferences = require("electron").systemPreferences;
    } catch {
      debugLogger.warn("systemPreferences unavailable, falling back to polling", {}, "meeting");
      this._startPollingFallback();
      return;
    }

    if (!systemPreferences.subscribeWorkspaceNotification) {
      debugLogger.warn(
        "subscribeWorkspaceNotification unavailable, falling back to polling",
        {},
        "meeting"
      );
      this._startPollingFallback();
      return;
    }

    const launchId = systemPreferences.subscribeWorkspaceNotification(
      "NSWorkspaceDidLaunchApplicationNotification",
      (_event, userInfo) => {
        const bundleId = userInfo?.NSApplicationBundleIdentifier;
        const processKey = bundleId ? BUNDLE_ID_MAP[bundleId] : null;
        if (processKey) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.debug("Workspace app launched", { bundleId, processKey }, "meeting");
          this._updateDetection(processKey, appName, true);
        }
      }
    );

    const terminateId = systemPreferences.subscribeWorkspaceNotification(
      "NSWorkspaceDidTerminateApplicationNotification",
      (_event, userInfo) => {
        const bundleId = userInfo?.NSApplicationBundleIdentifier;
        const processKey = bundleId ? BUNDLE_ID_MAP[bundleId] : null;
        if (processKey) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.debug("Workspace app terminated", { bundleId, processKey }, "meeting");
          this._updateDetection(processKey, appName, false);
        }
      }
    );

    this._subscriptionIds.push(launchId, terminateId);

    debugLogger.info(
      "Process detector started",
      {
        platform: "darwin",
        mode: "NSWorkspace",
        bundleIds: Object.keys(BUNDLE_ID_MAP),
      },
      "meeting"
    );

    this._initialScanDarwin();
  }

  async _initialScanDarwin() {
    try {
      const processList = await processListCache.getProcessList();
      const darwinProcessNames = [
        { match: "zoom.us", processKey: "zoom" },
        { match: "microsoft teams", processKey: "teams" },
        { match: "webex", processKey: "webex" },
        { match: "facetime", processKey: "facetime" },
      ];
      for (const { match, processKey } of darwinProcessNames) {
        if (processList.some((p) => p.includes(match))) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.info("Initial scan: already running", { processKey, appName }, "meeting");
          this._updateDetection(processKey, appName, true);
        }
      }
    } catch (err) {
      debugLogger.warn("Initial scan failed", { error: err.message }, "meeting");
    }
  }

  _startPollingFallback() {
    const apps = MEETING_APPS.linux || [];
    debugLogger.info(
      "Process detector started (polling fallback)",
      {
        platform: process.platform,
        appsMonitored: apps.map((a) => a.appName),
        intervalMs: POLL_INTERVAL_MS,
      },
      "meeting"
    );
    this._poll();
    this.pollInterval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this._subscriptionIds.length > 0) {
      try {
        const { systemPreferences } = require("electron");
        for (const id of this._subscriptionIds) {
          systemPreferences.unsubscribeWorkspaceNotification(id);
        }
      } catch {
        // electron may not be available during cleanup
      }
      this._subscriptionIds = [];
    }

    this.detectedProcesses.clear();
    this.dismissedProcesses.clear();
    this._micDerivedKeys.clear();
    debugLogger.info("Stopped meeting process detector", {}, "meeting");
  }

  dismiss(processKey) {
    this.dismissedProcesses.add(processKey);
    debugLogger.info("Process detection dismissed", { processKey }, "meeting");
  }

  getDetectedProcesses() {
    return Array.from(this.detectedProcesses.entries()).map(([processKey, { detectedAt }]) => ({
      processKey,
      appName: this._getAppName(processKey),
      detectedAt,
    }));
  }

  _getAppName(processKey) {
    if (process.platform === "darwin") {
      return BUNDLE_APP_NAMES[processKey] || processKey;
    }
    const apps = MEETING_APPS[process.platform] || [];
    const entry = apps.find((a) => a.processKey === processKey);
    return entry ? entry.appName : processKey;
  }

  // Windows helper-exe names are unreliable — current MSIX Teams does not spawn
  // ms-teams_modulehost.exe in-call. Ask the OS which apps hold the mic instead.
  async _activeMicProcessKeys() {
    try {
      const {
        getActiveMicSessions,
        mapIdentityToProcessKey,
      } = require("./windowsMicSessionDetector");
      const { ok, sessions } = await getActiveMicSessions();
      if (!ok) return { ok: false, entries: [] };

      const entries = [];
      for (const { identity } of sessions) {
        const entry = mapIdentityToProcessKey(identity);
        if (entry) entries.push(entry);
      }
      return { ok: true, entries };
    } catch (err) {
      debugLogger.debug("Mic session lookup failed", { error: err.message }, "meeting");
      return { ok: false, entries: [] };
    }
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const apps = MEETING_APPS[process.platform] || MEETING_APPS.linux || [];
      const processList = await processListCache.getProcessList();

      // Merge every source into one running set before deciding, so a key seen by
      // one signal is not immediately "ended" by the other reporting it absent.
      const running = new Set();
      const appNames = new Map();
      for (const { processKey, appName, imageName } of apps) {
        appNames.set(processKey, appName);
        if (processList.includes(imageName)) running.add(processKey);
      }

      if (process.platform === "win32") {
        const { ok, entries } = await this._activeMicProcessKeys();
        if (ok) {
          this._micDerivedKeys = new Set(entries.map((e) => e.processKey));
        } else {
          // A failed lookup is not evidence the meeting ended. Carry the last known
          // mic-derived keys so a transient `reg` error cannot emit a spurious
          // "ended", which would also clear the user's dismissal.
          for (const processKey of this._micDerivedKeys) {
            entries.push({ processKey, appName: this._getAppName(processKey) });
          }
        }
        for (const { processKey, appName } of entries) {
          running.add(processKey);
          if (!appNames.has(processKey)) appNames.set(processKey, appName);
        }
      }

      // Include already-detected keys so they can still transition to ended.
      for (const processKey of new Set([...appNames.keys(), ...this.detectedProcesses.keys()])) {
        const appName = appNames.get(processKey) || this._getAppName(processKey);
        this._updateDetection(processKey, appName, running.has(processKey));
      }
    } catch (err) {
      debugLogger.warn("Poll error", { error: err.message }, "meeting");
    } finally {
      this._polling = false;
    }
  }

  _updateDetection(processKey, appName, isRunning) {
    if (isRunning) {
      if (!this.detectedProcesses.has(processKey) && !this.dismissedProcesses.has(processKey)) {
        const detectedAt = Date.now();
        this.detectedProcesses.set(processKey, { detectedAt });
        debugLogger.info("Meeting process detected", { processKey, appName }, "meeting");
        this.emit("meeting-process-detected", { processKey, appName, detectedAt });
      }
    } else if (this.detectedProcesses.has(processKey)) {
      this.detectedProcesses.delete(processKey);
      this.dismissedProcesses.delete(processKey);
      debugLogger.info("Meeting process ended", { processKey, appName }, "meeting");
      this.emit("meeting-process-ended", { processKey, appName });
    }
  }
}

module.exports = MeetingProcessDetector;
