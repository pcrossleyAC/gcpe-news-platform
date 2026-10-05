import { useParams } from "react-router";

/** `/hub/releases/<id>` (and `/hub/releases/new`, from the "New release" button) — the real
 * editor is Task 3's job. This just gives rows and the New release button somewhere to land
 * without 404ing, per the brief ("that route can render a placeholder until Task 3"). */
export function ReleasePlaceholder(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="gcpe-release-placeholder">
      <h1>Release</h1>
      <p>The release editor isn&rsquo;t built yet (id: {id}).</p>
    </div>
  );
}
