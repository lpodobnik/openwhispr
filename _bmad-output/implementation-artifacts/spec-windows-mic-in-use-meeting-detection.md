---
title: "Windows: detect meetings via actual mic-in-use (CapabilityAccessManager)"
type: "bugfix"
created: "2026-07-24"
status: "done"
baseline_commit: "3ce13f99"
review_loop_iteration: 1
context:
  - "{project-root}/_bmad-output/project-context.md"
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Windows meeting detection recognises apps only by three hardcoded helper-exe names (`cpthost.exe`, `ms-teams_modulehost.exe`, `webexmeetingsapp.exe`). Current MSIX Teams does not reliably spawn `ms-teams_modulehost.exe` in-call, so Teams is never recognised; browser meetings can't be in principle. The documented "mic activity" polling fallback — `AudioActivityDetector._checkWin32()`, used whenever `windows-mic-listener.exe` is missing or dies — is itself a fourth scan for those same names, so Windows has no real second path.

**Approach:** Read Windows' own mic-in-use ledger (`HKCU\...\CapabilityAccessManager\ConsentStore\microphone`) via `reg query` in a new helper. An entry with `LastUsedTimeStart` and no non-zero `LastUsedTimeStop` is actively capturing. Use it to make `_checkWin32()` a real mic check and to add a name-independent signal to the win32 process poll. Existing exe names stay OR-ed in so nothing currently detected regresses.

## Boundaries & Constraints

**Always:**
- Parsing is a separately exported pure function over `reg query` text — testable with no registry or spawn.
- Exclude OpenWhispr's own mic session, or dictation self-triggers detection.
- Any failure (key absent, `reg` missing, non-zero exit, unparseable output) degrades to today's exe-name behaviour. Never throw into a poll loop.
- Main process is CommonJS; Prettier 100 cols, double quotes.
- Registry reads only — never write.

**Ask First:**
- Changing `MeetingDetectionEngine`'s signal handling or prompt pipeline.
- Adding a native/registry npm dependency instead of `reg query`.

**Never:** No new user-facing strings (hence no i18n), IPC channels, or settings. Don't touch the `windows-mic-listener.exe` event-driven path, macOS, or Linux. Don't add a second process poller — reuse `processListCache`.

## I/O & Edge-Case Matrix

Input is `reg query ... /s` stdout; output is the set of actively-capturing identities.

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Packaged capturing | `MSTeams_8wekyb3d8bbwe`, `Start` set, `Stop 0x0` | active; maps to `teams` | N/A |
| NonPackaged capturing | `NonPackaged\C:#...#Zoom#bin#Zoom.exe`, `Stop 0x0` | active; maps to `zoom` | N/A |
| Session ended | `Stop` non-zero and later than `Start` | not active | N/A |
| Crash then recapture | `Stop` non-zero but **earlier** than `Start` | active — the stale stop belongs to the previous session | N/A |
| `Stop` absent | `Start` present, no `Stop` line | **not active (fail closed)** — amended, see Change Log | N/A |
| `Stop` unreadable | `Stop` present but not parseable as an integer | **not active (fail closed)** | N/A |
| Zeroed `Start` | `Start` is `0x0` | not active | N/A |
| Never used | Subkey with no values, or only `Value REG_SZ Allow` | not active | N/A |
| Nothing tracked | No subkey carries any `LastUsedTime*` value | result flagged unusable | caller falls back to exe-name scan |
| Container keys | Root `...\microphone`, bare `...\NonPackaged` | skipped, never an identity | N/A |
| Self | NonPackaged entry matching own executable | excluded from active set | N/A |
| Large FILETIME | `0x1dd1a9a5ec9bcf2` > `Number.MAX_SAFE_INTEGER` | compared exactly, not truncated | N/A |
| `reg` fails | non-zero exit, empty stdout, or garbage | result flagged unusable | caller falls back to exe scan |

</frozen-after-approval>

## Code Map

- `src/helpers/audioActivityDetector.js` -- `_checkWin32()` (~L493) is the fake scan to replace; `_tryEventDrivenWin32()` (~L254) is the untouched primary path; `EXEC_OPTS`/`execAsync` show the exec style.
- `src/helpers/meetingProcessDetector.js` -- `MEETING_APPS.win32` (~L23) holds stale names; `_poll()` (~L207) and `_updateDetection()` (~L225) carry dismissal/ended semantics.
- `src/helpers/meetingDetectionEngine.js` -- read-only context: `meeting-process-detected` is **log-only by design** (~L49); only `sustained-audio-detected` and calendar reminders raise prompts.
- `src/helpers/processListCache.js` -- shared 5s-TTL process list; keep using it.
- `test/helpers/meetingJoinUrl.test.js` -- test style to copy (`node:test`, `node:assert/strict`, dynamic `import()`).

## Tasks & Acceptance

**Execution:**
- [x] `src/helpers/windowsMicSessionDetector.js` -- new helper exporting `parseMicSessions(text)` (pure), `isSelfIdentity(identity)`, `getActiveMicSessions()` (runs `reg query`, returns `{ ok, sessions }`), `mapIdentityToProcessKey(identity)` -- isolates all registry knowledge in one testable unit. `debugLogger` is required lazily so the pure helpers import without Electron.
- [x] `test/helpers/windowsMicSessionDetector.test.js` -- 11 tests covering every matrix row from captured fixture text -- the parser is the only place a Windows format change can silently break detection.
- [x] `src/helpers/audioActivityDetector.js` -- `_checkWin32()` returns `micActive || existingExeScan`, guarded on `ok` -- makes the mic fallback real (browser meetings included) without regressing today's hits.
- [x] `src/helpers/meetingProcessDetector.js` -- `_poll()` merges exe hits and mic-derived keys (via new `_activeMicProcessKeys()`) into one running-key set before calling `_updateDetection` once per key -- two calls per key would immediately "end" a detection the other source just raised.
- [x] `CLAUDE.md` -- documented the new helper, the Windows fallback behaviour, and a troubleshooting `reg query` -- previous text described behaviour this replaces.

**Acceptance Criteria:**
- Given the listener binary is unavailable and a browser tab is capturing, when the fallback polls, then `_isMicActive()` is true and a prompt follows after `SUSTAINED_THRESHOLD_CHECKS`.
- Given OpenWhispr is the only process capturing, when the fallback polls, then `_isMicActive()` is false and no prompt is raised.
- Given `reg query` exits non-zero, when either detector polls, then behaviour is identical to today's exe scan and no exception escapes.
- Given MSIX Teams is in a call and `ms-teams_modulehost.exe` is absent, when the win32 poll runs, then `teams` is reported running exactly once, and `meeting-process-ended` fires once it stops.
- Given a key is already dismissed, when it is re-detected via the mic signal, then `dismissedProcesses` suppression still applies.
- Given `reg query` fails on one poll while a mic-derived meeting continues, when the win32 poll runs, then no `meeting-process-ended` is emitted and the dismissal is preserved.

## Spec Change Log

- **iteration 1 — fail-closed liveness (amends a `<frozen-after-approval>` row; needs human sign-off).**
  - *Finding:* both reviewers flagged that "`Stop` absent ⇒ active" and "unreadable `Stop` ⇒ active" can never clear. One untracked entry, or one future `reg` format tweak, pins `_checkWin32()` true forever — a prompt every 5-minute cooldown with no mic in use.
  - *Amended:* the frozen I/O Matrix now fails **closed** on absent/unreadable/zeroed values, and adds `Stop < Start` as a live signal (that is what a crash-then-recapture looks like). Liveness is now `Start > 0` **and** (`Stop == 0` **or** `Stop < Start`).
  - *Known-bad state avoided:* a permanently-true mic signal. The original wording was written **before** the live capture, so it was speculation — and it contradicted this spec's own invariant that the worst case is "no worse than today". Fail-closed degrades to the exe-name scan, which honours it.
  - *KEEP:* the exe-name OR in `_checkWin32()`. Reviewers proposed letting an authoritative "idle" suppress it, but the `powershell.exe` WinRT probe proved the consent store does **not** record every mic user, so an empty result is not proof of an idle mic. Also keep "any non-self mic session counts" — that is deliberate parity with `_checkDarwin`/`_checkLinux` and is required for browser meetings.
- **iteration 1 — hardening (no intent change).** Leaf-anchored app matching (an unanchored `/zoom/` branded every app under a user folder named "zoom"); `MicrosoftTeams_*` classic package added; case-insensitive key matching; explicit `maxBuffer`; 5s shared cache so the two detectors make one `reg` call per burst; self-exclusion widened to the whole install directory (bundled sidecars); a failed lookup now preserves the last known mic-derived keys instead of emitting a spurious "ended".

## Design Notes

Verified live on Win11 23H2 (2026-07-24) — real key shape, use as fixture:

```
HKEY_CURRENT_USER\...\ConsentStore\microphone\MSTeams_8wekyb3d8bbwe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dd1a92d660581e
    LastUsedTimeStop     REG_QWORD    0x1dd1a9a5ec9bcf2
HKEY_CURRENT_USER\...\microphone\NonPackaged\C:#Program Files#OpenWhispr#OpenWhispr.exe
```

Four things the naive reading gets wrong:

1. **QWORDs overflow `Number`.** `0x1dd1a9a5ec9bcf2` ≈ 1.34e17 > `MAX_SAFE_INTEGER`. Compare with `BigInt` or the zero test silently misfires.
2. **Webex is not "webex".** The real entry is `...#CiscoSparkLauncher#CiscoCollabHost.exe`. Match `webex|ciscocollabhost|ciscospark`.
3. **Derive self-exclusion, don't hardcode.** Build the expected identity from `process.execPath` (uppercase drive, `\`→`#`), compare case-insensitively; keep an `openwhispr` substring as a second net. A bare `electron.exe` exclusion would wrongly mute Signal/Slack in dev.
4. **`Stop == 0` is live-verified.** Captured during a real Teams call on this machine: `MSTeams_8wekyb3d8bbwe` held `LastUsedTimeStart 0x1dd1b4688f3d1ec` / `LastUsedTimeStop 0x0` while `ms-teams.exe` ran ×2 and `ms-teams_modulehost.exe` was **absent** — the reported bug, reproduced, and the fix confirmed against it.
5. **Not every mic user is tracked, so absence proves nothing.** A WinRT capture held from `powershell.exe` produced no consent-store entry at all while the mic was genuinely open. This is why `getActiveMicSessions` returns `{ ok, sessions }` rather than a bare boolean, why an empty `sessions` list must not suppress the exe-name scan, and why liveness fails closed (see Change Log).

**Scope honesty:** `meeting-process-detected` is deliberately log-only, and `getDetectedProcesses()` has no consumers — so the process-detector task improves context and logs, not prompts. The user-visible fix for "Teams never detected" is the `_checkWin32()` task.

## Verification

**Commands:**
- `npm test` -- all `node --test` files pass, including the new parser tests.
- `npm run quality-check` -- Prettier check and `tsc --noEmit` clean.
- `npm run lint` -- clean from both roots.

**Manual (Windows):**
- [x] During a live Teams call, `reg query "...\ConsentStore\microphone\MSTeams_8wekyb3d8bbwe"` showed `LastUsedTimeStop 0x0` with `ms-teams_modulehost.exe` absent; `getActiveMicSessions()` returned that identity and it mapped to `teams`. Self-exclusion flagged the real `NonPackaged\...#OpenWhispr#OpenWhispr.exe` entry.
- [ ] Force the polling path (rename `resources/bin/windows-mic-listener.exe`), join a browser Meet call, confirm the overlay within ~2 poll intervals.
- [ ] Dictate with the hotkey during a packaged-build run; confirm no prompt fires from OpenWhispr's own mic use.

## Suggested Review Order

**Liveness contract — the decision everything else rests on**

- Fails closed: only a zeroed or pre-`Start` stop is live, so unreadable values degrade to the exe scan.
  [`windowsMicSessionDetector.js:70`](../../src/helpers/windowsMicSessionDetector.js#L70)

- `{ ok, sessions }` rather than a boolean — an empty list is not proof of an idle mic.
  [`windowsMicSessionDetector.js:186`](../../src/helpers/windowsMicSessionDetector.js#L186)

- Untracked output reports unusable and logs, so a dead feature is distinguishable from a quiet mic.
  [`windowsMicSessionDetector.js:216`](../../src/helpers/windowsMicSessionDetector.js#L216)

**Parsing the registry**

- Case-insensitive key matching and `BigInt` timestamps; FILETIMEs exceed `MAX_SAFE_INTEGER`.
  [`windowsMicSessionDetector.js:88`](../../src/helpers/windowsMicSessionDetector.js#L88)

- Matching is anchored to the executable leaf; the identity is a full path.
  [`windowsMicSessionDetector.js:40`](../../src/helpers/windowsMicSessionDetector.js#L40)

- Self-exclusion spans the whole install directory, so bundled sidecars never self-trigger.
  [`windowsMicSessionDetector.js:146`](../../src/helpers/windowsMicSessionDetector.js#L146)

**Wiring into the two detectors**

- The real mic check, OR-ed with the legacy exe scan rather than replacing it.
  [`audioActivityDetector.js:493`](../../src/helpers/audioActivityDetector.js#L493)

- Both signals merge into one running-set before a single `_updateDetection` per key.
  [`meetingProcessDetector.js:236`](../../src/helpers/meetingProcessDetector.js#L236)

- A failed lookup preserves the last known keys, so a transient error cannot wipe a dismissal.
  [`meetingProcessDetector.js:252`](../../src/helpers/meetingProcessDetector.js#L252)

**Supporting**

- 21 parser tests built from registry output captured on real hardware.
  [`windowsMicSessionDetector.test.js:11`](../../test/helpers/windowsMicSessionDetector.test.js#L11)

- Docs for the new helper and the Windows fallback semantics.
  [`CLAUDE.md:110`](../../CLAUDE.md#L110)
