import { Eye, Pencil, Rocket, ShieldCheck } from "lucide-react";
import type { User } from "./api";
import { roleOrder, roles } from "./roles";
import DescribedPicker from "./DescribedPicker";

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
export default function RolePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: User["role"];
  onChange: (role: User["role"]) => void;
  disabled?: boolean;
}) {
  return (
    <DescribedPicker
      label="Role"
      menuLabel="Choose role"
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={options}
    />
  );
}
