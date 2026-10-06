import { Check, Eye, Minus, Pencil, Rocket, ShieldCheck } from "lucide-react";
import type { User } from "./api";
import { capabilities, roleOrder, roles } from "./roles";
import DescribedPicker from "./DescribedPicker";
import "./account.css";

const icons = {
  viewer: Eye,
  editor: Pencil,
  operator: Rocket,
  admin: ShieldCheck,
};
const options = roleOrder.map((value) => ({
  value,
  label: roles[value][0],
  description: roles[value][1],
  icon: icons[value],
}));

/** Role choice with a plain preview of what that role can and can't do. */
export default function RolePicker({
  value,
  onChange,
  disabled = false,
  person,
}: {
  value: User["role"];
  onChange: (role: User["role"]) => void;
  disabled?: boolean;
  /** The person's first name, for "Jane will be able to". */
  person?: string;
}) {
  return (
    <div className="role-field">
      <DescribedPicker
        label="Role"
        menuLabel="Choose role"
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={options}
      />
      <RoleCapabilities role={value} person={person} />
    </div>
  );
}

export function RoleCapabilities({
  role,
  person,
}: {
  role: User["role"];
  person?: string;
}) {
  return (
    <div className="role-capabilities">
      <p>{person ? `${person} will be able to:` : "This role can:"}</p>
      <ul>
        {capabilities.map((capability) => {
          const allowed = (capability.roles as readonly string[]).includes(
            role,
          );
          return (
            <li key={capability.id} className={allowed ? "yes" : "no"}>
              {allowed ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Minus size={14} aria-hidden="true" />
              )}
              <span>
                <span className="sr-only">{allowed ? "Can: " : "Can't: "}</span>
                {capability.label}
              </span>
            </li>
          );
        })}
      </ul>
      {(role === "editor" || role === "operator") && (
        <p className="role-capabilities-note">
          Editors change drafts and operators publish them, so every change gets
          a second pair of eyes. Administrators can do both.
        </p>
      )}
    </div>
  );
}

/** Every role against every capability, for the role reference. */
export function RoleMatrix({ current }: { current?: User["role"] }) {
  return (
    <>
      <RoleTable current={current} />
      <dl className="role-list">
        {roleOrder.map((role) => (
          <div key={role} className={role === current ? "current" : ""}>
            <dt>
              {roles[role][0]}
              {role === current && <span className="role-you">Your role</span>}
            </dt>
            <dd>{roles[role][1]}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function RoleTable({ current }: { current?: User["role"] }) {
  return (
    <div className="role-matrix-wrap">
      <table className="role-matrix">
        <caption className="sr-only">Capabilities by role</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Capability</span>
            </th>
            {roleOrder.map((role) => (
              <th
                key={role}
                scope="col"
                className={role === current ? "current" : undefined}
              >
                {roles[role][0]}
                {role === current && (
                  <span className="sr-only"> (your role)</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {capabilities.map((capability) => (
            <tr key={capability.id}>
              <th scope="row">{capability.label}</th>
              {roleOrder.map((role) => {
                const allowed = (
                  capability.roles as readonly string[]
                ).includes(role);
                return (
                  <td
                    key={role}
                    className={`${allowed ? "yes" : "no"}${role === current ? " current" : ""}`}
                  >
                    {allowed ? (
                      <Check size={15} aria-label="Yes" />
                    ) : (
                      <Minus size={15} aria-label="No" />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
