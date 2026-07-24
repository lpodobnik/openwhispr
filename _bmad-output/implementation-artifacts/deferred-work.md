# Deferred Work

- source_spec: `spec-windows-mic-in-use-meeting-detection.md`
  summary: `MeetingProcessDetector._updateDetection` clears a user's dismissal whenever a key transitions to "ended", so any detect/end flap silently re-arms a dismissed prompt.
  evidence: Pre-existing behaviour at `src/helpers/meetingProcessDetector.js` (the `dismissedProcesses.delete(processKey)` in the ended branch), not introduced by this change. Impact is currently nil because `meeting-process-detected` is log-only in `MeetingDetectionEngine`, but it arms a real regression for any future consumer of that event. This spec removed the error-driven flap (a failed `reg` lookup now preserves the last known mic-derived keys); what remains is a genuine release/reacquire between two 30s polls. A miss-count threshold before emitting "ended" would close it.
