import { useSettingsStore, type SettingsState } from "../stores/settingsStore";
import { setVerifiedLanHosts } from "./urlUtils";

// Every server URL a user can point at their own network. Their hostnames are
// resolved in main (verify-lan-hosts), and those that resolve only to private
// addresses may use plain HTTP like a private IP would.
const LAN_URL_KEYS = [
  "remoteTranscriptionUrl",
  "meetingRemoteTranscriptionUrl",
  "uploadRemoteTranscriptionUrl",
  "cloudTranscriptionBaseUrl",
  "meetingCloudTranscriptionBaseUrl",
  "uploadCloudTranscriptionBaseUrl",
  "cleanupRemoteUrl",
  "dictationAgentRemoteUrl",
  "noteFormattingRemoteUrl",
  "translationRemoteUrl",
  "dictationAgentCloudBaseUrl",
  "dictationAgentVisionCloudBaseUrl",
  "noteFormattingCloudBaseUrl",
  "translationCloudBaseUrl",
] as const satisfies readonly (keyof SettingsState)[];

const DEBOUNCE_MS = 400;
// Main forgets a verified name after 5 minutes; re-check before that, so a host
// that moved off the private network stops counting as one.
const REFRESH_MS = 4 * 60_000;

const collectUrls = (state: SettingsState) =>
  LAN_URL_KEYS.map((key) => state[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

export function startLanHostSync(): () => void {
  const verify = window.electronAPI?.verifyLanHosts;
  if (!verify) return () => {};

  let lastKey = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const sync = (urls: string[]) => {
    const current = ++generation;
    verify(urls)
      .then((hostnames) => {
        if (current === generation && Array.isArray(hostnames)) setVerifiedLanHosts(hostnames);
      })
      .catch(() => {});
  };

  const schedule = (state: SettingsState) => {
    const urls = collectUrls(state);
    const key = urls.join("\n");
    if (key === lastKey) return;
    lastKey = key;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => sync(urls), DEBOUNCE_MS);
  };

  const initial = collectUrls(useSettingsStore.getState());
  lastKey = initial.join("\n");
  sync(initial);
  const unsubscribe = useSettingsStore.subscribe(schedule);
  const refresh = setInterval(() => sync(collectUrls(useSettingsStore.getState())), REFRESH_MS);

  return () => {
    unsubscribe();
    clearInterval(refresh);
    if (timer) clearTimeout(timer);
  };
}
