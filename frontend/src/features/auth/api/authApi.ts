import { apiFetch } from "../../../shared/api/apiFetch";
import type { User } from "../../../shared/api/types";

export function fetchMe(): Promise<User> {
  return apiFetch<User>("/v1/me");
}

export function logout(): Promise<void> {
  return apiFetch<void>("/auth/logout", {
    method: "POST",
  });
}
