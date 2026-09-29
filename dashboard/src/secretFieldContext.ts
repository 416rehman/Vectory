import { createContext } from "react";
import type { SecretPath } from "./secretFields";

/**
 * The component whose settings are on screen. Credential fields accept a
 * device secret only inside a component whose type lists them.
 */
export const SecretScopeContext = createContext<{
  kind: string;
  type: string;
  id: string;
} | null>(null);

/**
 * The field's place inside the component: object fields by name, list items
 * by index. Separate from display paths, which label list items for people.
 */
export const SecretPathContext = createContext<SecretPath>([]);

/** Device secret names the pipeline already uses, for reuse. */
export const SecretNamesContext = createContext<readonly string[]>([]);
