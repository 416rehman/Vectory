import { useEffect, useId, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import "./role-picker.css";

export type DescribedOption<Value extends string> = {
  value: Value;
  label: string;
  description: string;
  summary?: string;
  icon: LucideIcon;
};

/** Shared choice control for roles and other decisions that need context. */
export default function DescribedPicker<Value extends string>({
  label,
  menuLabel,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Choose an option",
}: {
  label: string;
  menuLabel: string;
  value: Value | "";
  options: readonly DescribedOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const Icon = selected?.icon;
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="field role-picker">
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <DropdownMenu.Root
        open={open && !disabled}
        onOpenChange={setOpen}
        modal={false}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            id={id}
            className="role-picker-trigger"
            disabled={disabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-value${selected ? ` ${id}-description` : ""}`}
          >
            {Icon && <Icon size={19} aria-hidden="true" />}
            <span className="role-picker-copy">
              <strong id={`${id}-value`}>
                {selected?.label || placeholder}
              </strong>
              {selected && (
                <span id={`${id}-description`}>
                  {selected.summary || selected.description}
                </span>
              )}
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="role-picker-menu"
            aria-label={menuLabel}
            tabIndex={0}
            align="start"
            sideOffset={6}
            collisionPadding={12}
            loop
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu.RadioGroup
              value={value}
              onValueChange={(next) => {
                const option = options.find((item) => item.value === next);
                if (!disabled && option) onChange(option.value);
              }}
            >
              {options.map((option) => {
                const OptionIcon = option.icon;
                return (
                  <DropdownMenu.RadioItem
                    key={option.value}
                    value={option.value}
                    textValue={option.label}
                    className="role-picker-option"
                    aria-label={option.label}
                    aria-describedby={`${id}-${option.value}-description`}
                  >
                    <OptionIcon size={18} aria-hidden="true" />
                    <span className="role-picker-copy">
                      <strong>{option.label}</strong>
                      <span id={`${id}-${option.value}-description`}>
                        {option.description}
                      </span>
                    </span>
                    <span className="role-picker-check">
                      <DropdownMenu.ItemIndicator>
                        <Check size={17} aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                    </span>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
