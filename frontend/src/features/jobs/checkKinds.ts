import type { CheckKind } from "../../shared/api/types";

/** One plain-words name per check kind, used by the task list, the task page and the new-task form. */
export const CHECK_KIND_LABELS: Record<CheckKind, string> = {
  ANSWER_KEY: "Compare with the right answer",
  SCHEMA: "Check the format",
  LATE_LABEL: "You mark answers right or wrong later",
  TEST_COMMAND: "Run a test",
};

/** How answers are checked for a task, said as a sentence. */
export const CHECK_KIND_EXPLAINED: Record<CheckKind, string> = {
  ANSWER_KEY: "Each answer is compared with the right answer you provide, field by field.",
  SCHEMA: "Each answer is checked against the format you describe, for example that it has a category field.",
  LATE_LABEL: "Answers start unchecked. You (or another system) mark each one right or wrong later.",
  TEST_COMMAND: "Each answer is checked by running a test you provide.",
};
