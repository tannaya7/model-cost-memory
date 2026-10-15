import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createJob } from "../api/jobsApi";
import { ApiError } from "../../../shared/api/apiFetch";
import type { JobCreate } from "../../../shared/api/types";

const jobFormSchema = z
  .object({
    name: z
      .string()
      .min(1, "Name is required")
      .max(100, "Name must be at most 100 characters")
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        "Name must start with an alphanumeric character and contain only letters, numbers, '.', '_', or '-'",
      ),
    description: z.string().max(500, "Description must be under 500 characters").optional(),
    check_kind: z.enum(["ANSWER_KEY", "SCHEMA"]),
    fields: z.array(z.object({ name: z.string() })).optional(),
    schemaJson: z.string().optional(),
    retest_consent: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (data.check_kind === "ANSWER_KEY") {
      const validFields = (data.fields || [])
        .map((f) => f.name.trim())
        .filter(Boolean);
      if (validFields.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields"],
          message: "At least one expected field name is required",
        });
      }
    } else if (data.check_kind === "SCHEMA") {
      if (!data.schemaJson || !data.schemaJson.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schemaJson"],
          message: "Schema JSON is required",
        });
      } else {
        try {
          const parsed = JSON.parse(data.schemaJson);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["schemaJson"],
              message: "Schema must be a valid JSON object",
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schemaJson"],
            message: "Invalid JSON format. Check brackets and quotes.",
          });
        }
      }
    }
  });

type JobFormValues = z.infer<typeof jobFormSchema>;

export function JobCreatePanel({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<JobFormValues>({
    resolver: zodResolver(jobFormSchema),
    defaultValues: {
      name: "",
      description: "",
      check_kind: "ANSWER_KEY",
      fields: [{ name: "vendor" }, { name: "invoice_number" }],
      schemaJson: JSON.stringify(
        {
          type: "object",
          required: ["category"],
          properties: {
            category: { type: "string" },
          },
        },
        null,
        2,
      ),
      retest_consent: false,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "fields",
  });

  const selectedKind = watch("check_kind");

  useEffect(() => {
    if (!isOpen) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const mutation = useMutation({
    mutationFn: (data: JobCreate) => createJob(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onSuccess("Job created");
      reset();
      setServerError(null);
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.status === 422) {
        setServerError(err.message || "Invalid job configuration.");
      } else if (err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError("Failed to create job.");
      }
    },
  });

  function onSubmit(values: JobFormValues) {
    setServerError(null);

    let checkConfig: Record<string, unknown> = {};
    if (values.check_kind === "ANSWER_KEY") {
      const fieldNames = (values.fields || [])
        .map((f) => f.name.trim())
        .filter(Boolean);
      checkConfig = { fields: fieldNames };
    } else {
      checkConfig = { schema: JSON.parse(values.schemaJson!) };
    }

    mutation.mutate({
      name: values.name.trim(),
      description: values.description?.trim() || null,
      check_kind: values.check_kind,
      check_config: checkConfig,
      retest_consent: values.retest_consent,
    });
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-create-title"
        className="relative z-50 flex h-full w-full max-w-3xl flex-col border-l border-rule bg-surface shadow-2xl overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-rule bg-surface px-6 py-4">
          <div>
            <h2 id="job-create-title" className="text-lg font-bold text-ink">
              Define a New Job
            </h2>
            <p className="text-xs text-dim">
              Set up how inputs are processed and how correct answers are verified.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close job form"
            className="rounded-md p-1.5 text-dim hover:bg-bg hover:text-ink focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-6">
          {serverError && (
            <div
              role="alert"
              className="rounded-md border border-bad bg-bad-soft p-4 text-sm text-bad"
            >
              <p className="font-semibold">Unable to create job</p>
              <p className="mt-1">{serverError}</p>
            </div>
          )}

          {/* Job Name */}
          <div>
            <label htmlFor="job-name" className="block text-sm font-medium text-ink">
              Job Name <span className="text-bad">*</span>
            </label>
            <input
              id="job-name"
              type="text"
              placeholder="e.g. invoice-extract"
              {...register("name")}
              className="mt-1 w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {errors.name && (
              <p className="mt-1 text-xs text-bad">{errors.name.message}</p>
            )}
            <p className="mt-1 text-xs text-dim">
              Letters, numbers, periods, dashes, and underscores only.
            </p>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="job-desc" className="block text-sm font-medium text-ink">
              Description <span className="text-dim text-xs font-normal">(optional)</span>
            </label>
            <textarea
              id="job-desc"
              rows={2}
              placeholder="Brief explanation of what this job evaluates..."
              {...register("description")}
              className="mt-1 w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {errors.description && (
              <p className="mt-1 text-xs text-bad">{errors.description.message}</p>
            )}
          </div>

          {/* Check Kind */}
          <div>
            <label className="block text-sm font-medium text-ink mb-2">
              Check Kind <span className="text-bad">*</span>
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  value="ANSWER_KEY"
                  {...register("check_kind")}
                  className="text-accent focus:ring-accent"
                />
                <span className="font-medium">Answer key</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  value="SCHEMA"
                  {...register("check_kind")}
                  className="text-accent focus:ring-accent"
                />
                <span className="font-medium">Schema</span>
              </label>
            </div>
          </div>

          {/* Check Settings & Worked Example (2-column layout) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left: Input configuration */}
            <div className="rounded-card border border-rule bg-surface p-4">
              {selectedKind === "ANSWER_KEY" ? (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-ink">
                      Expected Field Names <span className="text-bad">*</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => append({ name: "" })}
                      className="text-xs font-semibold text-accent hover:underline"
                    >
                      + Add field
                    </button>
                  </div>
                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {fields.map((field, index) => (
                      <div key={field.id} className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="e.g. total"
                          {...register(`fields.${index}.name` as const)}
                          className="flex-1 rounded-md border border-rule bg-surface px-2.5 py-1.5 text-xs text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                        {fields.length > 1 && (
                          <button
                            type="button"
                            onClick={() => remove(index)}
                            aria-label={`Remove field ${index + 1}`}
                            className="rounded p-1 text-dim hover:bg-bg hover:text-bad"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {errors.fields && (
                    <p className="mt-2 text-xs text-bad">{errors.fields.message}</p>
                  )}
                </div>
              ) : (
                <div>
                  <label htmlFor="schema-json" className="block text-sm font-medium text-ink mb-1">
                    JSON Schema <span className="text-bad">*</span>
                  </label>
                  <textarea
                    id="schema-json"
                    rows={8}
                    {...register("schemaJson")}
                    className="w-full font-mono text-xs rounded-md border border-rule bg-bg p-2.5 text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  {errors.schemaJson && (
                    <p className="mt-1 text-xs text-bad">{errors.schemaJson.message}</p>
                  )}
                </div>
              )}
            </div>

            {/* Right: Worked Example */}
            <div className="rounded-card border border-rule bg-bg p-4 flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-dim mb-2">
                  Worked Example ({selectedKind === "ANSWER_KEY" ? "Answer key" : "Schema"})
                </h4>
                {selectedKind === "ANSWER_KEY" ? (
                  <div className="space-y-3 text-xs">
                    <p className="text-dim">
                      A run passes when each listed field matches the expected answer.
                    </p>
                    <div className="rounded-md border border-rule bg-surface p-2.5">
                      <div className="font-semibold text-ink mb-1">Sample expected fields:</div>
                      <ul className="list-disc list-inside space-y-0.5 font-mono text-dim">
                        <li>vendor</li>
                        <li>invoice_number</li>
                        <li>date</li>
                        <li>total</li>
                      </ul>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 text-xs">
                    <p className="text-dim">
                      A run passes when its output matches the schema.
                    </p>
                    <div className="rounded-md border border-rule bg-surface p-2.5 font-mono overflow-x-auto text-dim">
                      <pre>
{`{
  "type": "object",
  "required": ["category"],
  "properties": {
    "category": { "type": "string" }
  }
}`}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Re-test Consent */}
          <div className="rounded-card border border-rule bg-surface p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                {...register("retest_consent")}
                className="mt-1 h-4 w-4 rounded border-rule text-accent focus:ring-accent"
              />
              <div>
                <span className="text-sm font-medium text-ink">Re-test Consent</span>
                <p className="mt-0.5 text-xs text-dim">
                  Allow this job's prompts to be replayed on another provider to test cheaper models.
                </p>
              </div>
            </label>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-rule">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-rule bg-surface px-4 py-2 text-sm font-medium text-dim hover:bg-bg hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation.isPending ? "Creating..." : "Create Job"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
