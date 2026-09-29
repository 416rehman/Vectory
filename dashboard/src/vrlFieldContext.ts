import { createContext, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import type { VrlEditorProblem } from "./VrlEditor";

/**
 * Services the component inspector offers to its VRL fields. Paths are the
 * dotted option path inside the component: `source`, `condition`,
 * `route.server_errors`, `routes.0.condition`.
 */
export type VrlFieldServices = {
  problems(path: string): readonly VrlEditorProblem[];
  pathHints: readonly string[];
  /** Rendered under the editor, e.g. the sample tester for this program. */
  after?(path: string): ReactNode;
  /** Open the wide editor for this field. */
  expand?(path: string): void;
  run?(path: string): void;
  registerView?(path: string, view: EditorView | null): void;
};

export const VrlFieldContext = createContext<VrlFieldServices | null>(null);
