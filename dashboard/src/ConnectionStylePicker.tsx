import { useCallback, useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import {
  normalizeConnectionStyle,
  type ConnectionStyle,
} from "./connectionStyle";

const STORAGE_KEY = "vectory-connection-style";
const options: {
  value: ConnectionStyle;
  label: string;
  description: string;
}[] = [
  { value: "curved", label: "Curved", description: "Smooth flowing lines" },
  {
    value: "orthogonal",
    label: "Right-angle",
    description: "Square, circuit-style corners",
  },
  {
    value: "straight",
    label: "Straight",
    description: "Direct lines between ports",
  },
];

function readStyle() {
  try {
    return normalizeConnectionStyle(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return normalizeConnectionStyle(null);
  }
}

export function useConnectionStyle() {
  const [style, setStyle] = useState<ConnectionStyle>(readStyle);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null)
        setStyle(readStyle());
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  const changeStyle = useCallback((value: ConnectionStyle) => {
    setStyle(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // The current view still works when browser storage is unavailable.
    }
  }, []);
  return [style, changeStyle] as const;
}

function StylePreview({ value }: { value: ConnectionStyle }) {
  return (
    <svg
      viewBox="0 0 36 24"
      width="24"
      height="20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={
          {
            curved: "M4 20 C22 20 14 4 32 4",
            orthogonal: "M4 20 H18 V4 H32",
            straight: "M4 20 L32 4",
          }[value]
        }
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="4" cy="20" r="2.3" fill="currentColor" />
      <circle cx="32" cy="4" r="2.3" fill="currentColor" />
    </svg>
  );
}

export default function ConnectionStylePicker({
  value,
  onChange,
}: {
  value: ConnectionStyle;
  onChange: (value: ConnectionStyle) => void;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="icon-button connection-style-trigger"
          aria-label="Connection style"
          title={`Connection style: ${options.find((option) => option.value === value)?.label}`}
        >
          <StylePreview value={value} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="connection-style-menu"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          <DropdownMenu.Label className="connection-style-menu-label">
            Connection style
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(normalizeConnectionStyle(next))}
          >
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="connection-style-option"
                aria-label={option.label}
              >
                <span className="connection-style-preview">
                  <StylePreview value={option.value} />
                </span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <DropdownMenu.ItemIndicator className="connection-style-selected">
                  <Check size={15} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
