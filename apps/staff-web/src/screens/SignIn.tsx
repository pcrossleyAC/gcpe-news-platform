import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Form, Header, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { Button } from "../shared/BusyButton";
import { ApiError, apiFetch } from "../api/client";
import { safeReturnTo } from "../session/safeReturnTo";
import { useSession } from "../session/SessionContext";
import { useDocumentTitle } from "../shared/useDocumentTitle";

const SIGN_IN_FAILED = "Sign-in failed. Check your user name and password.";
const RATE_LIMITED = "Too many attempts, wait a minute";
const NOT_SET_UP = "Your account hasn't been set up. Contact an administrator.";
const METHODS_UNAVAILABLE = "Microsoft sign-in is unavailable right now.";

/** Core's `?error=` codes from Microsoft sign-in (GET /core/auth/entra/callback). */
export const ENTRA_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "Your sign-in took too long. Please try again.",
  failed: "We couldn't sign you in with Microsoft. Please try again.",
  not_provisioned: NOT_SET_UP,
  inactive: NOT_SET_UP,
  conflict: "Your account needs an administrator to check it. Contact an administrator.",
};

interface SignInMethods {
  entra: boolean;
  local: boolean;
}
/** Until Core answers, or if it can't: the password form only, as before Entra. */
const DEFAULT_METHODS: SignInMethods = { entra: false, local: true };

export function SignIn(): React.JSX.Element {
  const { user, signIn } = useSession();
  useDocumentTitle("Sign in");
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [methods, setMethods] = useState<SignInMethods>(DEFAULT_METHODS);
  const [methodsUnavailable, setMethodsUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch<SignInMethods>("/core/auth/methods").then(
      (m) => live && setMethods({ entra: m.entra === true, local: m.local !== false }),
      () => live && setMethodsUnavailable(true),
    );
    return () => {
      live = false;
    };
  }, []);

  const returnTo = safeReturnTo(params.get("return"));
  if (user) return <Navigate to={returnTo} replace />;

  // Looked up with Object.hasOwn, never a plain `[]` index: ENTRA_ERRORS is a plain object
  // literal, so `?error=__proto__` would otherwise return Object.prototype (which React
  // refuses to render) and `?error=toString`/`constructor` would return a function (an alert
  // with no text). Never reflects the query value itself.
  const errorCode = params.get("error");
  const entraError = errorCode !== null && Object.hasOwn(ENTRA_ERRORS, errorCode) ? ENTRA_ERRORS[errorCode] : null;
  // Core takes a /hub/ path: the router's paths are relative to its /hub basename.
  const entraHref = `/core/auth/entra?returnTo=${encodeURIComponent(`/hub${returnTo}`)}`;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(username, password);
      // Render falls through to the `user` redirect above on the next render.
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 429 ? RATE_LIMITED : SIGN_IN_FAILED);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="gcpe-sign-in">
      <Header title="GCPE News — Staff" />
      <h1>Sign in</h1>
      {(error ?? entraError) && <InlineAlert variant="danger" role="alert" description={(error ?? entraError)!} />}
      {methodsUnavailable && !methods.entra && <InlineAlert variant="info" description={METHODS_UNAVAILABLE} />}
      {methods.entra && (
        <p className="gcpe-sign-in__entra">
          <a className="gcpe-button-link" href={entraHref}>
            Sign in with Microsoft
          </a>
        </p>
      )}
      {methods.entra && methods.local && <p className="gcpe-sign-in__or">Or sign in with a password:</p>}
      {methods.local && (
        <Form onSubmit={onSubmit}>
          <TextField label="User name" name="username" value={username} onChange={setUsername} isRequired autoComplete="username" />
          <TextField label="Password" name="password" type="password" value={password} onChange={setPassword} isRequired autoComplete="current-password" />
          <Button type="submit" isPending={submitting} pendingLabel="Signing in…">
            Sign in
          </Button>
        </Form>
      )}
    </main>
  );
}
