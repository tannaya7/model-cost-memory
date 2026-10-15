import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { ErrorMessage } from "./ErrorMessage";
import { TableSkeleton } from "./Skeleton";

export interface QueryResultLike<T> {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  data: T | undefined;
}

/**
 * The one wrapper that handles loading, empty and error for every fetched screen.
 * Supports both standard queries and infinite queries.
 */
export function QueryState<T>({
  query,
  isEmpty,
  emptyTitle,
  emptyHint,
  skeleton,
  children,
}: {
  query: QueryResultLike<T>;
  isEmpty?: (data: T) => boolean;
  emptyTitle: string;
  emptyHint?: ReactNode;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <TableSkeleton />}</>;
  if (query.isError) return <ErrorMessage error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined) return <>{skeleton ?? <TableSkeleton />}</>;

  const data = query.data;
  const empty = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (empty) return <EmptyState title={emptyTitle} hint={emptyHint} />;
  return <>{children(data)}</>;
}
