import { useRef, useState } from "react";
import { can, type User } from "./api";
import { ErrorBox, PageHeader, useResource } from "./ui";
import { AccountActions, WorkspaceAccess } from "./AccountAccess";
import MfaActions from "./MfaActions";
import AddPersonActions from "./AddPersonActions";
import AdminPasswordResetActions, {
  type AdminPasswordResetHandle,
} from "./AdminPasswordResetActions";
import "./control.css";

export function UsersSecurity({
  user,
  notify,
  onUserChanged,
  onSignIn,
  onReload,
}: {
  user: User;
  notify: (m: string) => void;
  onUserChanged: (user: User | null) => void;
  onSignIn: () => void;
  onReload: () => void;
}) {
  const { data, error, reload, loading } = useResource<User[]>(
    can(user, "admin") ? "/users" : null,
    [],
  );
  const [savedPerson, setSavedPerson] = useState<User | null>(null);
  const resetRef = useRef<AdminPasswordResetHandle>(null);
  function created(person: User) {
    setSavedPerson(person);
    void reload();
  }
  return (
    <div className="control-page">
      <PageHeader
        title="People & security"
        description="Manage workspace access and protect your account."
        help={{ topic: "administer" }}
      >
        <AddPersonActions
          user={user}
          notify={notify}
          onCreated={created}
          onObserved={created}
          onReviewNeeded={() => void reload()}
        />
        <AdminPasswordResetActions
          ref={resetRef}
          user={user}
          people={data}
          reload={reload}
        />
      </PageHeader>
      {error && <ErrorBox message={error} retry={() => void reload()} />}
      <MfaActions key={`mfa:${user.id}`} user={user} notify={notify} />
      <AccountActions
        key={`account:${user.id}`}
        user={user}
        notify={notify}
        onUserChanged={onUserChanged}
        onChanged={reload}
        onSignIn={onSignIn}
        onReload={onReload}
      />
      <WorkspaceAccess
        user={user}
        people={data}
        reload={reload}
        notify={notify}
        onUserChanged={onUserChanged}
        savedPerson={savedPerson}
        onPersonLocated={() => setSavedPerson(null)}
        onResetPassword={(person) => resetRef.current?.open(person)}
        showTable={can(user, "admin")}
        loading={loading}
      />
    </div>
  );
}
