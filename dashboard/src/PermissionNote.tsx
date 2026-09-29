import { Lock } from "lucide-react";
import type { User } from "./api";
import { roles, rolesFor } from "./roles";
import { PageHeader } from "./ui";
import "./account.css";

/**
 * A calm explanation for something the current role can't do, with who can
 * change it. Use instead of an error when access, not a failure, is the cause.
 */
export default function PermissionNote({
  user,
  needs,
  action,
  title,
}: {
  user: User;
  needs: "edit" | "operate" | "admin";
  /** What needs the role, as a sentence subject: "Adding devices". */
  action: string;
  /** The page's own title, when the note stands in for a whole page. */
  title?: string;
}) {
  const required = rolesFor(needs);
  const current = roles[user.role][0];
  const article = /^[AEIOU]/.test(current) ? "an" : "a";
  const note = (
    <section className="permission-note" role="note">
      <Lock size={18} aria-hidden="true" />
      <div>
        <h2>Needs the {required} role</h2>
        <p>
          {action} needs the {required} role. You're {article} {current}. Ask an
          administrator to change your role.
        </p>
      </div>
    </section>
  );
  if (!title) return note;
  return (
    <div className="control-page">
      <PageHeader title={title} />
      {note}
    </div>
  );
}
