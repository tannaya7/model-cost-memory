import type { components } from "./generated";

export type Job = components["schemas"]["JobOut"];
export type JobCreate = components["schemas"]["JobCreate"];
export type Run = components["schemas"]["RunOut"];
export type RunDetail = components["schemas"]["RunDetail"];
export type RunPage = components["schemas"]["RunPage"];
export type LabelCreate = components["schemas"]["LabelCreate"];
export type CheckKind = components["schemas"]["JobCreate"]["check_kind"];

export type Model = components["schemas"]["ModelOut"];
export type ModelPage = components["schemas"]["ModelPage"];
export type ModelStatus = components["schemas"]["ModelOut"]["status"];

export type Verdict = components["schemas"]["RecommendationOut"]["verdict"];
export type Recommendation = components["schemas"]["RecommendationOut"];
export type ModelEvidence = components["schemas"]["ModelEvidenceOut"];
export type ModelEvidenceStatus = ModelEvidence["status"];
export type FailingRun = components["schemas"]["FailingRunOut"];
export type SpendInsight = components["schemas"]["SpendOut"];
export type Forecast = components["schemas"]["ForecastOut"];
export type History = components["schemas"]["HistoryOut"];
export type HistoryEntry = components["schemas"]["HistoryEntryOut"];
export type Alert = components["schemas"]["AlertOut"];
export type RegressionAlert = Alert;
export type RetestStatus = components["schemas"]["RetestOut"];
export type RetestExecutionStatus = RetestStatus["status"];
export type RetestCreateInput = components["schemas"]["RetestCreate"];
export type RetestLimits = components["schemas"]["RetestLimits"];
export type ProviderKeyInput = components["schemas"]["ProviderKeyIn"];
export type ProviderKey = components["schemas"]["ProviderKeyOut"];


export type User = components["schemas"]["UserOut"];
export type AuthConfig = components["schemas"]["AuthConfig"];
export type Project = components["schemas"]["ProjectOut"];
export type ProjectCreateInput = components["schemas"]["ProjectCreate"];
export type ProjectCreateResult = components["schemas"]["ProjectCreated"];
export type ProjectPatchInput = components["schemas"]["ProjectPatch"];
export type ProjectKeyResult = components["schemas"]["ProjectKey"];
export type JobInsights = components["schemas"]["JobInsightsOut"];
export type Breakdown = components["schemas"]["BreakdownOut"];
