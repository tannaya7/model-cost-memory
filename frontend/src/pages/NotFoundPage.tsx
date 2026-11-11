import { Link } from "react-router-dom";
import { EmptyState } from "../shared/components/EmptyState";

export default function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      hint={
        <Link to="/" className="text-accent underline">
          Back to the overview
        </Link>
      }
    />
  );
}
