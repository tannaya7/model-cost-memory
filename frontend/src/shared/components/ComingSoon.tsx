import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";

/** Placeholder body for routes that are built in later weeks. */
export function ComingSoon({ title, week }: { title: string; week: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title="Not built yet" hint={`This screen arrives in ${week}.`} />
    </>
  );
}
