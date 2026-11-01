import { Component, type ReactNode } from "react";
import { ErrorMessage } from "./ErrorMessage";

interface State {
  error: unknown;
}

/** One per route: a crash in one screen shows an error there, not a blank app. */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <ErrorMessage error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
