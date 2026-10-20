import type { CheckKind } from "../../shared/api/types";

/** One display name per check kind, used by the jobs table and the new-job form. */
export const CHECK_KIND_LABELS: Record<CheckKind, string> = {
  ANSWER_KEY: "Answer key",
  SCHEMA: "Schema",
  LATE_LABEL: "Late label",
  TEST_COMMAND: "Test command",
};
