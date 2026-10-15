import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { EmptyState } from "./EmptyState";
import { ErrorMessage } from "./ErrorMessage";
import { TableSkeleton } from "./Skeleton";

/**
 * The one wrapper that handles loading, empty and error for every fetched screen.
 * Change how any of the three looks here and every screen follows.
 */
export function QueryState<T>({
  query,
  isEmpty,
  emptyTitle,
  emptyHint,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  emptyTitle: string;
  emptyHint?: ReactNode;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <TableSkeleton />}</>;
  if (query.isError) return <ErrorMessage error={query.error} onRetry={() => query.refetch()} />;
  const data = query.data;
  const empty = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (empty) return <EmptyState title={emptyTitle} hint={emptyHint} />;
  return <>{children(data)}</>;
}
