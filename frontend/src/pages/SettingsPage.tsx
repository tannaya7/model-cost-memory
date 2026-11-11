import { PageHeader } from "../shared/components/PageHeader";
import { ProjectKeySettings } from "../features/settings/components/ProjectKeySettings";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Manage your project API key and configuration."
      />
      <ProjectKeySettings />
    </>
  );
}
