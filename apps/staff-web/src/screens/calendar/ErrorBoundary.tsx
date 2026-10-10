import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";

interface Props {
  children: ReactNode;
  /** Defaults to a real page reload; a test passes its own so it never has to touch navigation. */
  onReload?: () => void;
}

interface State {
  hasError: boolean;
}

/** Wraps the Calendar's routed screens: a render error in any one of them shows this recoverable
 * message instead of leaving the page blank. */
export class CalendarErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  // Deliberately nothing here beyond the state flip above: the error and its stack can carry
  // activity titles, search text or other content a user typed, and nothing the Calendar catches
  // may be logged.
  componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <InlineAlert
          variant="danger"
          role="alert"
          title="Something went wrong"
          description="This section couldn’t be shown."
          buttons={
            <Button variant="secondary" onPress={this.props.onReload ?? (() => window.location.reload())}>
              Reload
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}
