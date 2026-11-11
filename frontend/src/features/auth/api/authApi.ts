import { apiFetch } from "../../../shared/api/apiFetch";
import type { AuthConfig, User } from "../../../shared/api/types";

export function fetchMe(): Promise<User> {
  return apiFetch<User>("/v1/me");
}

export function fetchAuthConfig(): Promise<AuthConfig> {
  return apiFetch<AuthConfig>("/auth/config");
}

export function devLogin(email: string): Promise<User> {
  return apiFetch<User>("/auth/dev/login", { method: "POST", body: JSON.stringify({ email }) });
}

export function logout(): Promise<void> {
  return apiFetch<void>("/auth/logout", {
    method: "POST",
  });
}
