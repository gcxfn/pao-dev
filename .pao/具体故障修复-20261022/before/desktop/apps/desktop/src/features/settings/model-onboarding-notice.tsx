import type { ModelOnboardingNotice } from "./model-onboarding";
import { useI18n } from "../../i18n/react";

interface ModelOnboardingNoticeBannerProps {
  readonly notice: ModelOnboardingNotice | undefined;
  readonly onOpenSettings: (section: ModelOnboardingNotice["actionSection"]) => void;
}

export function ModelOnboardingNoticeBanner({
  notice,
  onOpenSettings,
}: ModelOnboardingNoticeBannerProps) {
  const { t } = useI18n();
  if (!notice) {
    return null;
  }

  return (
    <div className="model-onboarding-notice" data-testid="model-onboarding-notice">
      <div className="model-onboarding-notice__body">
        <span className="model-onboarding-notice__title">{t(notice.title)}</span>
        <span className="model-onboarding-notice__description">
          {t(notice.description, notice.descriptionParams)}
        </span>
      </div>
      <button
        className="model-onboarding-notice__action"
        type="button"
        onClick={() => onOpenSettings(notice.actionSection)}
      >
        {t(notice.actionLabel)}
      </button>
    </div>
  );
}
