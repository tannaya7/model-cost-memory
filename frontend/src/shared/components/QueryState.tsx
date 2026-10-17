import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { ErrorMessage } from "./ErrorMessage";
import { StaleDataNotice } from "./StaleDataNotice";
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
  // A failed first load has nothing to show, so show the error.
  if (query.isError && query.data === undefined) {
    return <ErrorMessage error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.data === undefined) return <>{skeleton ?? <TableSkeleton />}</>;

  const data = query.data;
  // A failed background refresh keeps the last good data on screen, with a small notice.
  const notice = query.isError ? <StaleDataNotice onRetry={() => query.refetch()} /> : null;
  const empty = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (empty) return <>{notice}<EmptyState title={emptyTitle} hint={emptyHint} /></>;
  return <>{notice}{children(data)}</>;
}
