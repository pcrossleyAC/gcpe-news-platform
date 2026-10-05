import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Button, Form, Header, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { ApiError } from "../api/client";
import { useSession } from "../session/SessionContext";

const SIGN_IN_FAILED = "Sign-in failed. Check your user name and password.";
const RATE_LIMITED = "Too many attempts, wait a minute";

export function SignIn(): React.JSX.Element {
  const { user, signIn } = useSession();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to={params.get("return") || "/"} replace />;

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
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      <Form onSubmit={onSubmit}>
        <TextField label="User name" name="username" value={username} onChange={setUsername} isRequired autoComplete="username" />
        <TextField label="Password" name="password" type="password" value={password} onChange={setPassword} isRequired autoComplete="current-password" />
        <Button type="submit" isDisabled={submitting}>
          Sign in
        </Button>
      </Form>
    </main>
  );
}
