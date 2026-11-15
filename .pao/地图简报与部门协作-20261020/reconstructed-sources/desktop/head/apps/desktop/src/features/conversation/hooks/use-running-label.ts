import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n/react";
import { translate } from "../../../../contracts/i18n";

export function useRunningLabel(startedAt: string | undefined) {
  const { language } = useI18n();
  const [label, setLabel] = useState(() => formatRunningLabel(startedAt, language));

  useEffect(() => {
    setLabel(formatRunningLabel(startedAt, language));
    if (!startedAt) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setLabel(formatRunningLabel(startedAt, language));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [startedAt, language]);

  return label;
}

/** 右上角「已运行」标签的纯格式化（导出供单测钉真机 P0 回归：秒数须对 60 取模）。 */
export function formatRunningLabel(startedAt: string | undefined, language: "en" | "zh"): string {
  if (!startedAt) {
    return translate(language, "Working…");
  }

  const diffMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const seconds = Math.max(1, Math.floor(diffMs / 1000));
  if (seconds < 60) {
    return translate(language, "Working for {seconds}s", { seconds });
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0
    ? translate(language, "Working for {minutes}m", { minutes })
    : // 模板槽位是「分钟后的余秒」，必须对 60 取模；传总秒数会显示成「7m 345s」（真机 P0 期发现）。
      translate(language, "Working for {minutes}m {seconds}s", { minutes, seconds: remaining });
}
