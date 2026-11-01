import { useState } from "react";
import { setActiveProject } from "../shared/api/apiFetch";
import { queryClient } from "../shared/api/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PageHeader } from "../shared/components/PageHeader";
import { Card } from "../shared/components/Card";
import { QueryState } from "../shared/components/QueryState";
import { useProjects, useCreateProject } from "../features/projects/hooks/useProjects";
import { ProjectCard } from "../features/projects/components/ProjectCard";
import { ApiKeyRevealBox } from "../features/projects/components/ApiKeyRevealBox";
import { ApiError } from "../shared/api/apiFetch";

const newProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(60, "Project name must be 60 characters or fewer"),
});

type NewProjectFormValues = z.infer<typeof newProjectSchema>;

export default function ProjectsPage() {
  const projectsQuery = useProjects();
  const createMutation = useCreateProject();

  const [newlyCreatedKey, setNewlyCreatedKey] = useState<{
    apiKey: string;
    projectName: string;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<NewProjectFormValues>({
    resolver: zodResolver(newProjectSchema),
    defaultValues: {
      name: "",
    },
  });

  const onSubmit = async (data: NewProjectFormValues) => {
    setFormError(null);
    try {
      const result = await createMutation.mutateAsync({ name: data.name });
      setActiveProject(result.project.project_id); // the dashboard now shows the new project
      queryClient.invalidateQueries();
      setNewlyCreatedKey({
        apiKey: result.api_key,
        projectName: result.project.name,
      });
      reset();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setFormError(err.message);
      } else if (err instanceof Error) {
        setFormError(err.message);
      } else {
        setFormError("Failed to create project");
      }
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <PageHeader
        title="Projects"
        subtitle="Manage your projects, API keys, and re-test configurations."
      />

      {/* Show newly created API key if available */}
      {newlyCreatedKey && (
        <ApiKeyRevealBox
          apiKey={newlyCreatedKey.apiKey}
          title={`Project "${newlyCreatedKey.projectName}" created! Copy this key now.`}
          onDismiss={() => setNewlyCreatedKey(null)}
        />
      )}

      {/* Projects List */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-dim">
          Your Projects
        </h3>
        <QueryState
          query={projectsQuery}
          emptyTitle="No projects yet"
          emptyHint="Create your first project below to start tracking models and runs."
        >
          {(projects) => (
            <div className="space-y-3">
              {projects.map((project) => (
                <ProjectCard key={project.project_id} project={project} />
              ))}
            </div>
          )}
        </QueryState>
      </section>

      {/* Create Project Card */}
      <Card className="p-6">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-ink">
              Create New Project
            </h3>
            <p className="mt-0.5 text-xs text-dim">
              Projects group jobs, recorded runs, and spend history under a
              unique live API key.
            </p>
          </div>

          {formError && (
            <div className="rounded-md border border-bad/30 bg-bad-soft p-3 text-xs text-bad">
              {formError}
            </div>
          )}

          <div>
            <label
              htmlFor="project-name"
              className="block text-sm font-medium text-ink mb-1"
            >
              Project Name <span className="text-bad">*</span>
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <input
                  id="project-name"
                  type="text"
                  placeholder="e.g. production-east"
                  {...register("name")}
                  className="w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
                {errors.name && (
                  <p className="mt-1 text-xs text-bad">
                    {errors.name.message}
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition-opacity"
              >
                {createMutation.isPending ? "Creating..." : "Create Project"}
              </button>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}
