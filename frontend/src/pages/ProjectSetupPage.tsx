import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PageHeader } from "../shared/components/PageHeader";
import { Card } from "../shared/components/Card";
import { Skeleton } from "../shared/components/Skeleton";
import {
  useProject,
  usePatchProject,
  useRegenerateProjectKey,
} from "../features/projects/hooks/useProjects";
import { ApiKeyRevealBox } from "../features/projects/components/ApiKeyRevealBox";
import { ApiError } from "../shared/api/apiFetch";

const projectSetupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(60, "Project name must be 60 characters or fewer"),
  webhook_url: z
    .string()
    .trim()
    .refine((val) => !val || val.startsWith("https://"), {
      message: "Webhook URL must start with https://",
    }),
  retest_monthly_cap_usd: z
    .number()
    .min(0, "Cap must be at least $0")
    .max(500, "Cap cannot exceed $500"),
  retest_allowed: z.boolean(),
});

type ProjectSetupFormValues = z.infer<typeof projectSetupSchema>;

export default function ProjectSetupPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const projectQuery = useProject(projectId);
  const patchMutation = usePatchProject();
  const regenerateMutation = useRegenerateProjectKey();

  const [savedSuccess, setSavedSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [regeneratedKey, setRegeneratedKey] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<ProjectSetupFormValues>({
    resolver: zodResolver(projectSetupSchema),
    defaultValues: {
      name: "",
      webhook_url: "",
      retest_monthly_cap_usd: 10,
      retest_allowed: true,
    },
  });

  const project = projectQuery.data;

  // Sync form default values once project is loaded
  useEffect(() => {
    if (project) {
      reset({
        name: project.name,
        webhook_url: project.webhook_url || "",
        retest_monthly_cap_usd: project.retest_monthly_cap_usd,
        retest_allowed: project.retest_allowed,
      });
    }
  }, [project, reset]);

  const onSave = async (data: ProjectSetupFormValues) => {
    if (!projectId) return;
    setSaveError(null);
    setSavedSuccess(false);

    try {
      await patchMutation.mutateAsync({
        id: projectId,
        input: {
          name: data.name,
          webhook_url: data.webhook_url ? data.webhook_url : null,
          retest_monthly_cap_usd: data.retest_monthly_cap_usd,
          retest_allowed: data.retest_allowed,
        },
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setSaveError(err.message);
      } else if (err instanceof Error) {
        setSaveError(err.message);
      } else {
        setSaveError("Failed to save project settings");
      }
    }
  };

  const handleRegenerate = async () => {
    if (!projectId) return;
    try {
      const result = await regenerateMutation.mutateAsync(projectId);
      setRegeneratedKey(result.api_key);
      setShowRegenConfirm(false);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setSaveError(err.message);
      } else if (err instanceof Error) {
        setSaveError(err.message);
      } else {
        setSaveError("Failed to regenerate API key");
      }
    }
  };

  if (projectQuery.isPending) {
    return (
      <div className="space-y-6 max-w-3xl">
        <PageHeader title="Project Settings" subtitle="Loading configuration..." />
        <Card className="p-6 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-32" />
        </Card>
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="space-y-6 max-w-3xl">
        <PageHeader
          title="Project Settings"
          subtitle="Project configuration and credentials."
          actions={
            <Link
              to="/projects"
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-dim hover:text-ink hover:bg-bg"
            >
              ← Back to Projects
            </Link>
          }
        />
        <div
          role="alert"
          className="rounded-card border border-bad/30 bg-bad-soft p-8 text-center text-sm text-bad"
        >
          <p className="font-semibold text-base">We couldn't find that project.</p>
          <p className="mt-1 text-xs">
            The project ID "{projectId}" does not exist or you do not have permission to access it.
          </p>
          <div className="mt-4">
            <Link
              to="/projects"
              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent"
            >
              View Projects
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <PageHeader
        title={project.name}
        subtitle="Manage project settings, webhook notifications, and API credentials."
        actions={
          <Link
            to="/projects"
            className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-dim hover:text-ink hover:bg-bg"
          >
            ← Projects
          </Link>
        }
      />

      {/* Show newly regenerated API key */}
      {regeneratedKey && (
        <ApiKeyRevealBox
          apiKey={regeneratedKey}
          title="New API key generated! Copy this key now."
          onDismiss={() => setRegeneratedKey(null)}
        />
      )}

      {/* Main Settings Form */}
      <Card className="p-6">
        <form onSubmit={handleSubmit(onSave)} className="space-y-6">
          <div className="border-b border-rule pb-4 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-ink">
                General Settings
              </h3>
              <p className="mt-0.5 text-xs text-dim">
                Project ID: <span className="font-mono">{project.project_id}</span>
              </p>
            </div>
            {savedSuccess && (
              <span className="rounded-full bg-ok-soft px-3 py-1 text-xs font-semibold text-ok">
                Saved
              </span>
            )}
          </div>

          {saveError && (
            <div className="rounded-md border border-bad/30 bg-bad-soft p-3 text-xs text-bad">
              {saveError}
            </div>
          )}

          {/* Project Name */}
          <div>
            <label
              htmlFor="project-name"
              className="block text-sm font-medium text-ink mb-1"
            >
              Project Name <span className="text-bad">*</span>
            </label>
            <input
              id="project-name"
              type="text"
              {...register("name")}
              className="w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {errors.name && (
              <p className="mt-1 text-xs text-bad">{errors.name.message}</p>
            )}
          </div>

          {/* Alert Webhook URL */}
          <div>
            <label
              htmlFor="webhook-url"
              className="block text-sm font-medium text-ink mb-1"
            >
              Alert Webhook URL{" "}
              <span className="text-xs font-normal text-dim">(optional)</span>
            </label>
            <input
              id="webhook-url"
              type="url"
              placeholder="https://example.com/alerts-webhook"
              {...register("webhook_url")}
              className="w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {errors.webhook_url && (
              <p className="mt-1 text-xs text-bad">
                {errors.webhook_url.message}
              </p>
            )}
            <p className="mt-1 text-xs text-dim">
              Receives regression and deprecation alerts. Paste a Slack, Discord, Google Chat or Mattermost incoming-webhook URL to get them in a channel, or your own https:// endpoint (payloads are signed with the webhook secret).
            </p>
          </div>

          {/* Monthly Re-test Budget */}
          <div>
            <label
              htmlFor="retest-cap"
              className="block text-sm font-medium text-ink mb-1"
            >
              Monthly Re-test Budget (USD) <span className="text-bad">*</span>
            </label>
            <div className="relative max-w-xs">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-dim">
                $
              </span>
              <input
                id="retest-cap"
                type="number"
                step="1"
                min="0"
                max="500"
                {...register("retest_monthly_cap_usd", { valueAsNumber: true })}
                className="w-full rounded-md border border-rule bg-surface pl-7 pr-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            {errors.retest_monthly_cap_usd && (
              <p className="mt-1 text-xs text-bad">
                {errors.retest_monthly_cap_usd.message}
              </p>
            )}
            <p className="mt-1 text-xs text-dim">
              Maximum monthly spend cap for sandboxed re-tests ($0 to $500).
            </p>
          </div>

          {/* Re-test Consent Switch */}
          <div className="rounded-card border border-rule bg-bg p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                {...register("retest_allowed")}
                className="mt-1 h-4 w-4 rounded border-rule text-accent focus:ring-accent"
              />
              <div>
                <span className="text-sm font-semibold text-ink">
                  Allow re-tests (sends prompts to a second provider)
                </span>
                <p className="mt-0.5 text-xs text-warn">
                  Warning: Enabling this allows historical prompt payloads to be evaluated against candidate models.
                </p>
              </div>
            </label>
          </div>

          {/* Save Button */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-rule">
            <button
              type="submit"
              disabled={patchMutation.isPending || !isDirty}
              className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition-opacity"
            >
              {patchMutation.isPending ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </Card>

      {/* Project Key Section */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-ink">Project Key</h3>
          <p className="mt-0.5 text-xs text-dim">
            The API key used by clients and SDKs to authenticate requests for this project.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-md border border-rule bg-bg">
          <div>
            <span className="text-xs text-dim block">Current Key Prefix</span>
            <span className="font-mono text-sm font-bold text-ink">
              {project.key_prefix}…
            </span>
          </div>

          {!showRegenConfirm && (
            <button
              type="button"
              onClick={() => setShowRegenConfirm(true)}
              className="rounded-md border border-rule bg-surface px-4 py-2 text-xs font-semibold text-dim hover:text-bad hover:border-bad/40 hover:bg-bg transition-colors"
            >
              Regenerate key
            </button>
          )}
        </div>

        {/* Inline confirmation for regenerating key */}
        {showRegenConfirm && (
          <div
            role="alert"
            className="rounded-card border border-warn/40 bg-warn-soft p-4 space-y-3"
          >
            <div>
              <h4 className="text-sm font-semibold text-ink">
                Are you sure you want to regenerate this project key?
              </h4>
              <p className="mt-0.5 text-xs text-dim">
                Existing SDK integrations and services using the current key will immediately stop working until updated with the new key.
              </p>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={regenerateMutation.isPending}
                className="rounded-md bg-bad px-3.5 py-1.5 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {regenerateMutation.isPending
                  ? "Regenerating..."
                  : "Confirm Regenerate"}
              </button>
              <button
                type="button"
                onClick={() => setShowRegenConfirm(false)}
                className="rounded-md border border-rule bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink hover:bg-bg"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
