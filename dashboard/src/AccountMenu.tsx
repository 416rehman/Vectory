import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  BookOpen,
  ChevronsUpDown,
  ExternalLink,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
} from "lucide-react";
import type { User } from "./api";
import { helpHref } from "./DocLink";
import SignOutDialog from "./SignOutDialog";
import { Kbd } from "./ui";
import { roles } from "./roles";
import "./account-menu.css";

type Appearance = "light" | "dark" | "auto";

export type AccountMenuProps = {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: Appearance;
  onThemeChange: (theme: Appearance) => void;
  onNavigate: (path: string) => void;
  onBeforeSignOut: () => boolean;
  onSignedOut: () => void;
  onReload: () => void;
  onShowShortcuts?: () => void;
  mobile?: boolean;
  currentPage?: string;
};

const appearances = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "auto", label: "Auto", icon: Monitor },
] as const;

export default function AccountMenu({
  user,
  open,
  onOpenChange,
  theme,
  onThemeChange,
  onNavigate,
  onBeforeSignOut,
  onSignedOut,
  onReload,
  onShowShortcuts,
  mobile = false,
  currentPage,
}: AccountMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signOutReview, setSignOutReview] = useState(false);
  const initials = (user.name.trim() || user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase();
  const role = roles[user.role]?.[0] ?? user.role;

  function closeConfirmation() {
    setConfirmingSignOut(false);
    onOpenChange(false);
  }

  return (
    <>
      <DropdownMenu.Root
        open={open && !confirmingSignOut}
        onOpenChange={(next) => {
          if (next) {
            setConfirmingSignOut(false);
          }
          onOpenChange(next);
        }}
        modal={false}
      >
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="account-button"
            aria-label="Your account"
            title="Your account"
          >
            <span className="account-initial" aria-hidden="true">
              {initials}
            </span>
            <span className="account-text">
              <span className="account-name">{user.name || user.email}</span>
              <span className="account-button-role">{role}</span>
            </span>
            <ChevronsUpDown size={15} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="account-menu"
            data-account-menu=""
            data-mobile={mobile || undefined}
            aria-label="Your account"
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            loop
            onEscapeKeyDown={(event) => event.stopPropagation()}
            onCloseAutoFocus={(event) => {
              if (confirmingSignOut) event.preventDefault();
            }}
          >
            <div className="account-menu-identity">
              <span className="account-initial" aria-hidden="true">
                {initials}
              </span>
              <span>
                <strong>{user.name || user.email}</strong>
                <span>{user.email}</span>
              </span>
              <span className="account-menu-role">{role}</span>
            </div>
            <DropdownMenu.Label className="account-menu-label">
              Appearance
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              className="account-menu-appearance"
              aria-label="Appearance"
              value={theme}
              onValueChange={(value) => {
                if (value === "light" || value === "dark" || value === "auto")
                  onThemeChange(value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    '[role="menuitemradio"]:not([data-disabled])',
                  ),
                );
                const index = items.indexOf(
                  document.activeElement as HTMLElement,
                );
                if (index < 0 || !items.length) return;
                event.preventDefault();
                event.stopPropagation();
                const next =
                  (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    items.length) %
                  items.length;
                items[next].focus();
                onThemeChange(appearances[next].value);
              }}
            >
              {appearances.map(({ value, label, icon: Icon }) => (
                <DropdownMenu.RadioItem
                  key={value}
                  value={value}
                  className="account-menu-theme"
                  onSelect={(event) => event.preventDefault()}
                  title={
                    value === "auto" ? "Use your system appearance" : undefined
                  }
                >
                  <Icon size={15} aria-hidden="true" />
                  <span>{label}</span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator className="account-menu-separator" />
            <DropdownMenu.Item
              className="account-menu-item"
              aria-current={currentPage === "settings" ? "page" : undefined}
              onSelect={(event) => {
                event.preventDefault();
                onNavigate("settings");
              }}
            >
              <Settings size={16} aria-hidden="true" />
              <span>Settings</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="account-menu-item"
              aria-current={currentPage === "users" ? "page" : undefined}
              onSelect={(event) => {
                event.preventDefault();
                onNavigate("users");
              }}
            >
              <ShieldCheck size={16} aria-hidden="true" />
              <span>People &amp; security</span>
            </DropdownMenu.Item>
            {onShowShortcuts && (
              <DropdownMenu.Item
                className="account-menu-item"
                onSelect={(event) => {
                  event.preventDefault();
                  onOpenChange(false);
                  onShowShortcuts();
                }}
              >
                <Keyboard size={16} aria-hidden="true" />
                <span>Keyboard shortcuts</span>
                <Kbd keys="?" />
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item asChild className="account-menu-item">
              <a
                href={helpHref()}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Help center (opens in a new tab)"
              >
                <BookOpen size={16} aria-hidden="true" />
                <span>Help center</span>
                <ExternalLink
                  className="account-menu-external"
                  size={13}
                  aria-hidden="true"
                />
              </a>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="account-menu-separator" />
            <DropdownMenu.Item
              className="account-menu-item account-menu-signout"
              onSelect={(event) => {
                event.preventDefault();
                // Keep the parent account overlay open so the mobile navigation
                // focus trap stays suspended while this dialog owns focus.
                setConfirmingSignOut(true);
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              <span>
                {signOutReview ? "Check sign-out status" : "Sign out"}
              </span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <SignOutDialog
        user={user}
        open={open && confirmingSignOut}
        onClose={closeConfirmation}
        onBeforeSignOut={onBeforeSignOut}
        onSignedOut={onSignedOut}
        onReload={onReload}
        onReviewChange={setSignOutReview}
        returnFocusRef={triggerRef}
      />
    </>
  );
}
