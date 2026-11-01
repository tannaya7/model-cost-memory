import { PageHeader } from "../shared/components/PageHeader";
import { RetestStartPanel } from "../features/retest/components/RetestStartPanel";

export default function RetestPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Start a Re-test"
        subtitle="Safely evaluate alternative candidate models on historical job traffic without affecting production."
      />
      <RetestStartPanel />
    </div>
  );
}
