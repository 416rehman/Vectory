import { useId, useLayoutEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderText,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  lintGutter,
  lintKeymap,
  setDiagnostics,
  type Diagnostic as EditorDiagnostic,
} from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { vrlCompletions, vrlHover, vrlLanguage } from "./vrlLanguage";
import { applyFix, type Problem } from "./pipelineProblems";
import "./vrl-editor.css";

export type VrlEditorProblem = Pick<
  Problem,
  | "severity"
  | "message"
  | "hint"
  | "code"
  | "line"
  | "column"
  | "length"
  | "fix"
>;

const external = Annotation.define<boolean>();
const highlighting = HighlightStyle.define([
  { tag: tags.propertyName, class: "vrl-path" },
  { tag: tags.function(tags.variableName), class: "vrl-function" },
  { tag: tags.variableName, class: "vrl-variable" },
  { tag: tags.string, class: "vrl-string" },
  { tag: [tags.regexp, tags.special(tags.string)], class: "vrl-literal" },
  { tag: [tags.number, tags.bool, tags.null], class: "vrl-number" },
  { tag: tags.keyword, class: "vrl-keyword" },
  { tag: tags.comment, class: "vrl-comment" },
  { tag: tags.operator, class: "vrl-operator" },
  { tag: [tags.bracket, tags.punctuation], class: "vrl-punctuation" },
]);

/** Convert Vector findings (1-based line/column) into editor ranges with fixes. */
export function editorDiagnostics(
  doc: EditorState["doc"],
  problems: readonly VrlEditorProblem[],
): EditorDiagnostic[] {
  const text = doc.toString();
  return problems.flatMap((problem) => {
    if (!problem.line || problem.line > doc.lines) {
      return [
        {
          from: 0,
          to: Math.min(doc.length, doc.line(1).length),
          severity: problem.severity,
          message: problem.message,
        },
      ];
    }
    const line = doc.line(problem.line);
    const characters = [...line.text];
    const column = Math.max(1, problem.column || 1);
    const offset = characters.slice(0, column - 1).join("").length;
    const from = Math.min(line.to, line.from + offset);
    const span = characters
      .slice(column - 1, column - 1 + Math.max(1, problem.length || 1))
      .join("").length;
    const to = Math.min(line.to, from + span) || from;
    const fixed = problem.fix ? applyFix(text, problem) : null;
    return [
      {
        from,
        to: Math.max(from, to),
        severity: problem.severity,
        source: problem.code,
        message: problem.hint
          ? `${problem.message}\n${problem.hint}`
          : problem.message,
        actions:
          problem.fix && fixed !== null
            ? [
                {
                  name: problem.fix.label,
                  apply(view: EditorView) {
                    view.dispatch({
                      changes: {
                        from: 0,
                        to: view.state.doc.length,
                        insert: fixed,
                      },
                      userEvent: "input.fix",
                    });
                  },
                },
              ]
            : undefined,
      },
    ];
  });
}

function contentAttributes(
  label: string,
  description: string,
  readOnly: boolean,
  invalid: boolean,
) {
  return EditorView.contentAttributes.of({
    role: "textbox",
    "aria-label": label,
    "aria-multiline": "true",
    "aria-readonly": String(readOnly),
    "aria-invalid": String(invalid),
    "aria-describedby": description,
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
  });
}

export type VrlEditorProps = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  readOnly?: boolean;
  problems?: readonly VrlEditorProblem[];
  /** Event paths offered after `.` (from the current samples). */
  pathHints?: readonly string[];
  describedBy?: string;
  placeholder?: string;
  /** Minimum visible lines before the editor grows with its content. */
  minLines?: number;
  /** Maximum height in lines before scrolling; omitted in the expanded editor. */
  maxLines?: number;
  onRun?: () => void;
  autoFocus?: boolean;
  /** Receives the editor so owners can move the cursor to a finding. */
  onView?: (view: EditorView | null) => void;
};

/** Locally bundled VRL editor. Syntax and semantic checks come from pinned Vector. */
export default function VrlEditor({
  value,
  onChange,
  label,
  readOnly = false,
  problems = [],
  pathHints = [],
  describedBy,
  placeholder,
  minLines = 4,
  maxLines = 18,
  onRun,
  autoFocus,
  onView,
}: VrlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<{
    view: EditorView;
    permissions: Compartment;
    attributes: Compartment;
  } | null>(null);
  const callbacks = useRef({ onChange, onRun, pathHints, readOnly });
  callbacks.current = { onChange, onRun, pathHints, readOnly };
  const instructions = useId();
  const description = [instructions, describedBy].filter(Boolean).join(" ");
  const invalid = problems.some((problem) => problem.severity === "error");

  useLayoutEffect(() => {
    const permissions = new Compartment(),
      attributes = new Compartment();
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentUnit.of("  "),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({
            override: [vrlCompletions(() => callbacks.current.pathHints)],
            icons: false,
            activateOnTypingDelay: 60,
          }),
          vrlLanguage,
          vrlHover,
          syntaxHighlighting(highlighting),
          highlightActiveLine(),
          lintGutter(),
          EditorView.lineWrapping,
          placeholder ? placeholderText(placeholder) : [],
          permissions.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          attributes.of(
            contentAttributes(label, description, readOnly, invalid),
          ),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                callbacks.current.onRun?.();
                return !!callbacks.current.onRun;
              },
            },
            { key: "Mod-/", run: toggleComment },
            ...closeBracketsKeymap,
            ...completionKeymap,
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...lintKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(external),
              )
            )
              callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = { view, permissions, attributes };
    onView?.(view);
    if (autoFocus) view.focus();
    return () => {
      onView?.(null);
      editor.current = null;
      view.destroy();
    };
    // The view lives for the component lifetime; prop changes use transactions.
  }, []);

  useLayoutEffect(() => {
    const current = editor.current;
    if (!current) return;
    current.view.dispatch({
      effects: [
        current.permissions.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        current.attributes.reconfigure(
          contentAttributes(label, description, readOnly, invalid),
        ),
      ],
    });
  }, [readOnly, label, description, invalid]);

  useLayoutEffect(() => {
    const view = editor.current?.view;
    if (!view) return;
    const previous = view.state.doc.toString();
    if (value === previous) return;
    let from = 0,
      oldTo = previous.length,
      newTo = value.length;
    while (from < oldTo && from < newTo && previous[from] === value[from])
      from++;
    while (
      oldTo > from &&
      newTo > from &&
      previous[oldTo - 1] === value[newTo - 1]
    ) {
      oldTo--;
      newTo--;
    }
    view.dispatch({
      changes: { from, to: oldTo, insert: value.slice(from, newTo) },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useLayoutEffect(() => {
    const view = editor.current?.view;
    if (!view) return;
    view.dispatch(
      setDiagnostics(view.state, editorDiagnostics(view.state.doc, problems)),
    );
  }, [problems, value]);

  return (
    <div
      className="vrl-editor"
      data-readonly={readOnly || undefined}
      data-invalid={invalid || undefined}
      style={
        {
          "--vrl-min-lines": minLines,
          "--vrl-max-lines": maxLines,
        } as React.CSSProperties
      }
    >
      <div className="vrl-editor-host" ref={host} />
      <span className="sr-only" id={instructions}>
        VRL editor. Tab indents; press Escape then Tab to leave the editor.
        Control or Command plus Space shows completions.
        {onRun && " Control or Command plus Enter runs the samples."}
      </span>
    </div>
  );
}
