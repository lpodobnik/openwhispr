import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import LanguageSelector from "../ui/LanguageSelector";
import { useToast } from "../ui/useToast";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  setMeetingSessionLanguage,
  useMeetingRecordingStore,
} from "../../stores/meetingRecordingStore";

/**
 * Spoken-language picker shown beside the note's record control while a meeting
 * is recording. It switches this recording only; Settings keep their language.
 */
export default function MeetingLanguageSwitch() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const sessionLanguage = useMeetingRecordingStore((s) => s.sessionLanguage);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const [switching, setSwitching] = useState(false);
  const value = sessionLanguage ?? preferredLanguage ?? "auto";

  const handleChange = async (language: string) => {
    if (language === value || switching) return;
    setSwitching(true);
    const switched = await setMeetingSessionLanguage(language);
    setSwitching(false);
    if (!switched) {
      toast({
        title: t("notes.meeting.title"),
        description: t("notes.meeting.languageSwitchFailed"),
        variant: "destructive",
      });
    }
  };

  return (
    <div
      title={t("notes.meeting.languageSwitch")}
      aria-label={t("notes.meeting.languageSwitch")}
      aria-busy={switching}
      className={cn(
        "w-36 shrink-0 transition-opacity",
        switching && "pointer-events-none opacity-60"
      )}
    >
      <LanguageSelector value={value} onChange={handleChange} />
    </div>
  );
}
