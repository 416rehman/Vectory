import type { Config } from "./api";
import { patternInputs, unmatchedPatternMessage } from "./inputPatterns";

/** One structured finding from the isolated Vector worker (see CONTRACT.md). */
export type VectorDiagnostic = {
  severity: "error" | "warning";
  message: string;
  section?: string;
  component?: string;
  route_output?: string;
  field?: string;
  code?: string;
  line?: number;
  column?: number;
  length?: number;
  hint?: string;
  detail?: string;
  docs_url?: string;
  fix?: { label: string; replacement: string; scope: "span" | "line" };
};

export type PipelineCheck = {
  valid: boolean;
  vector_validated: boolean;
  static_checked?: boolean;
  deferred?: boolean;
  deferred_reasons?: string[];
  placeholders?: string[];
  diagnostics?: VectorDiagnostic[];
  errors: string[];
  warnings: string[];
};

export type ProblemSection =
  "sources" | "transforms" | "sinks" | "enrichment_tables" | "tests" | "global";

export type Problem = {
  key: string;
  severity: "error" | "warning";
  /** `draft`: instant local checks. `vector`: the last pinned-Vector check. */
  origin: "draft" | "vector";
  section?: ProblemSection;
  component?: string;
  field?: string;
  routeOutput?: string;
  message: string;
  hint?: string;
  code?: string;
  line?: number;
  column?: number;
  length?: number;
  detail?: string;
  docsUrl?: string;
  fix?: VectorDiagnostic["fix"];
  /** The pipeline changed after this Vector finding was produced. */
  stale?: boolean;
};

export type LocalDiagnostic = {
  severity: "error" | "warning";
  message: string;
  code?: string;
  componentId?: string;
  enrichmentTableId?: string;
};

const sectionOf = (config: Config, id: string): ProblemSection | undefined =>
  (["sources", "transforms", "sinks", "enrichment_tables"] as const).find(
    (section) =>
      !!config?.[section] &&
      typeof config[section] === "object" &&
      Object.hasOwn(config[section], id),
  );

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split a local message into the option it names and the finding: both
 * `parse: Enter source.` and `sinks.out.buffer.max_size: must be …` carry a
 * component prefix, and the second also the option path.
 */
function localMessage(message: string, component?: string) {
  const prefixed =
    component &&
    new RegExp(
      `^(?:(?:sources|transforms|sinks|enrichment_tables)\\.)?${escapeRegExp(component)}(?:\\.([^:\\s]+))?: ([\\s\\S]*)$`,
    ).exec(message);
  const text = sentence(prefixed ? prefixed[2] : message);
  const required = /^Enter ([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.$/.exec(text);
  return {
    message: text,
    field: prefixed?.[1] || required?.[1],
    code: required ? "missing_field" : undefined,
  };
}

const sentence = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const first = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?:)`]$/.test(first) ? first : `${first}.`;
};

/** Instant checks: schema, structure, connectivity and variable fields. */
export function localProblems(
  diagnostics: readonly LocalDiagnostic[],
  connectivity: ReadonlyMap<string, string>,
  variableMessages: readonly string[],
  config: Config,
): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const push = (problem: Omit<Problem, "key">) => {
    const key = `draft:${problem.severity}:${problem.component || ""}:${problem.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ ...problem, key });
  };
  for (const item of diagnostics) {
    // Native references are checked with placeholders; the check's verdict
    // names what each device still resolves.
    if (item.code === "deferred") continue;
    const component = item.componentId || item.enrichmentTableId;
    const { message, field, code } = localMessage(item.message, component);
    push({
      severity: item.severity,
      origin: "draft",
      component:
        component && sectionOf(config, component) ? component : undefined,
      section: component ? sectionOf(config, component) : "global",
      message,
      ...(field ? { field } : {}),
      ...(code ? { code } : {}),
    });
  }
  for (const [component, message] of connectivity)
    push({
      severity: "warning",
      origin: "draft",
      component,
      section: sectionOf(config, component),
      code: "no_destination",
      message,
    });
  // A wildcard input is drawn on the canvas; it only needs a word here when it
  // matches nothing.
  for (const input of patternInputs(config))
    if (!input.matches.length && sectionOf(config, input.target)) {
      const { message, hint } = unmatchedPatternMessage(input, config);
      push({
        severity: "warning",
        origin: "draft",
        component: input.target,
        section: sectionOf(config, input.target),
        field: "inputs",
        code: "pattern_unmatched",
        message,
        hint,
      });
    }
  for (const message of variableMessages)
    push({
      severity: "error",
      origin: "draft",
      section: "global",
      code: "variables",
      message: sentence(message),
    });
  return problems;
}

/** Diagnostics that say the check itself could not run or finish. */
const CHECK_FAILURES = new Set([
  "validator_unavailable",
  "validator_incomplete",
]);

const GENERIC_PATTERN_NOTE =
  /^dynamic input pattern requires native Vector topology validation\.?$/i;
/** Vector's own words for a pipeline with no source or destination. */
const NATIVE_EMPTY = /^No (?:sources|sinks) defined in the config\.?$/i;
const LOCAL_EMPTY = /^Add a (?:source|destination)\b/;

/** Findings from the last Vector check, falling back to older text-only servers. */
export function checkProblems(
  check: PipelineCheck | null,
  config: Config,
  stale = false,
): Problem[] {
  if (!check) return [];
  if (Array.isArray(check.diagnostics))
    return check.diagnostics.flatMap((item, index): Problem[] => {
      // A check that could not run is the check's state, not a pipeline problem.
      if (item.code && CHECK_FAILURES.has(item.code)) return [];
      // The structural pass cannot expand wildcards; the draft's own preview
      // and the check's device note say what is left to resolve.
      if (!item.code && GENERIC_PATTERN_NOTE.test(item.message.trim()))
        return [];
      const component =
        item.component && sectionOf(config, item.component)
          ? item.component
          : undefined;
      return [
        {
          key: `vector:${index}:${item.component || ""}:${item.code || ""}:${item.line || 0}:${item.column || 0}:${item.message}`,
          severity: item.severity,
          origin: "vector",
          section:
            (item.section as ProblemSection) ||
            (component ? sectionOf(config, component) : "global"),
          component,
          field: item.field,
          routeOutput: item.route_output,
          message: sentence(item.message),
          hint: item.hint,
          code: item.code,
          line: item.line,
          column: item.column,
          length: item.length,
          detail: item.detail,
          docsUrl: item.docs_url,
          fix: item.fix,
          stale,
        },
      ];
    });
  return check.errors.map((message, index) => {
    const prefix = /^(?:(?:sources|transforms|sinks)\.)?([^:\s]+): /.exec(
      message,
    );
    const component =
      prefix && sectionOf(config, prefix[1]) ? prefix[1] : undefined;
    return {
      key: `vector:legacy:${index}:${message}`,
      severity: "error" as const,
      origin: "vector" as const,
      section: component ? sectionOf(config, component) : ("global" as const),
      component,
      message: sentence(component ? message.slice(prefix![0].length) : message),
      stale,
    };
  });
}

/** Vector settings errors a local finding for the same step already covers. */
const SETTINGS_CODES = new Set([
  "missing_field",
  "invalid_type",
  "invalid_value",
]);

/**
 * Local and Vector findings without repeats. A local finding Vector reports in
 * the same words is shown once. Where the local check already flags a step's
 * settings, Vector's settings errors for that step give way: Vector stops at
 * the first one it meets, and a check after the fix reports anything left.
 * Unknown options and VRL, input and type findings always stay.
 */
export function mergeProblems(local: Problem[], vector: Problem[]) {
  const identity = (problem: Problem) =>
    `${problem.component || ""}:${problem.message.toLowerCase()}`;
  const vectorKeys = new Set(vector.map(identity));
  const localErrors = local.filter((problem) => problem.severity === "error");
  const flagged = new Set(localErrors.map((problem) => problem.component));
  const repeated = (problem: Problem) =>
    problem.severity === "error" &&
    ((problem.code === "empty_pipeline" &&
      localErrors.some(
        (item) => !item.component && item.section === "global",
      )) ||
      (NATIVE_EMPTY.test(problem.message) &&
        localErrors.some((item) => LOCAL_EMPTY.test(item.message))) ||
      (!!problem.component &&
        flagged.has(problem.component) &&
        (!problem.code || SETTINGS_CODES.has(problem.code))));
  return [
    ...local.filter((problem) => !vectorKeys.has(identity(problem))),
    ...vector.filter((problem) => !repeated(problem)),
  ];
}

/**
 * After an edit, a Vector finding keeps its position and quick fix only while
 * the program it points into is unchanged since the check.
 */
export function settleStaleProblems(
  problems: Problem[],
  program: (
    draft: "checked" | "current",
    component: string,
    field: string,
  ) => string | null,
): Problem[] {
  return problems.map((problem) => {
    if (
      !problem.stale ||
      !problem.component ||
      !problem.field ||
      (!problem.line && !problem.fix)
    )
      return problem;
    const before = program("checked", problem.component, problem.field);
    if (
      before !== null &&
      before === program("current", problem.component, problem.field)
    )
      return problem;
    const moved = { ...problem };
    delete moved.line;
    delete moved.column;
    delete moved.length;
    delete moved.fix;
    return moved;
  });
}

export type ProblemGroup = {
  key: string;
  component?: string;
  section?: ProblemSection;
  problems: Problem[];
  errors: number;
  warnings: number;
};

const severityRank = (problem: Problem) =>
  problem.severity === "error" ? 0 : 1;

/** Components in the order events flow: each step after the steps it reads. */
export function pipelineOrder(config: Config) {
  const sections = ["sources", "transforms", "sinks", "enrichment_tables"];
  const rank = new Map<string, number>(),
    parents = new Map<string, string[]>();
  sections.forEach((section, index) => {
    const entries = config?.[section];
    if (!entries || typeof entries !== "object") return;
    for (const [id, component] of Object.entries(entries as Config)) {
      rank.set(id, index);
      const inputs = Array.isArray(component?.inputs) ? component.inputs : [];
      parents.set(
        id,
        inputs
          .filter(
            (input: unknown): input is string => typeof input === "string",
          )
          .map((input: string) => input.split(".")[0]),
      );
    }
  });
  const depth = new Map<string, number>();
  const measure = (id: string, trail: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    trail.add(id);
    const upstream = (parents.get(id) || []).filter((parent) =>
      rank.has(parent),
    );
    const value = upstream.length
      ? 1 + Math.max(...upstream.map((parent) => measure(parent, trail)))
      : 0;
    trail.delete(id);
    depth.set(id, value);
    return value;
  };
  const table = (id: string) => (rank.get(id) === 3 ? 1 : 0);
  const ids = [...rank.keys()];
  for (const id of ids) measure(id, new Set());
  ids.sort(
    (a, b) =>
      table(a) - table(b) ||
      depth.get(a)! - depth.get(b)! ||
      rank.get(a)! - rank.get(b)! ||
      a.localeCompare(b),
  );
  return new Map(ids.map((id, index) => [id, index]));
}

/** Group by component in the order events flow, pipeline-wide last. */
export function groupProblems(
  problems: Problem[],
  config: Config,
): ProblemGroup[] {
  const order = pipelineOrder(config);
  const groups = new Map<string, ProblemGroup>();
  for (const problem of problems) {
    const key = problem.component
      ? `component:${problem.component}`
      : `section:${problem.section || "global"}`;
    const group =
      groups.get(key) ||
      groups
        .set(key, {
          key,
          component: problem.component,
          section: problem.section,
          problems: [],
          errors: 0,
          warnings: 0,
        })
        .get(key)!;
    group.problems.push(problem);
    if (problem.severity === "error") group.errors++;
    else group.warnings++;
  }
  for (const group of groups.values())
    group.problems.sort(
      (a, b) =>
        severityRank(a) - severityRank(b) ||
        (a.line || 0) - (b.line || 0) ||
        (a.column || 0) - (b.column || 0),
    );
  return [...groups.values()].sort((a, b) => {
    const rank = (group: ProblemGroup) =>
      group.component ? (order.get(group.component) ?? 1e6) : 2e6;
    return (b.errors > 0 ? 1 : 0) - (a.errors > 0 ? 1 : 0) || rank(a) - rank(b);
  });
}

export function countProblems(problems: readonly Problem[]) {
  let errors = 0,
    warnings = 0;
  for (const problem of problems)
    if (problem.severity === "error") errors++;
    else warnings++;
  return { errors, warnings };
}

/** Per-component counts for node badges. Connectivity has its own badge. */
export function componentProblems(problems: readonly Problem[]) {
  const map = new Map<
    string,
    { errors: number; warnings: number; first: Problem }
  >();
  for (const problem of problems) {
    if (!problem.component || problem.code === "no_destination") continue;
    const entry = map.get(problem.component);
    if (!entry)
      map.set(problem.component, {
        errors: problem.severity === "error" ? 1 : 0,
        warnings: problem.severity === "warning" ? 1 : 0,
        first: problem,
      });
    else {
      if (problem.severity === "error") {
        entry.errors++;
        if (entry.first.severity !== "error") entry.first = problem;
      } else entry.warnings++;
    }
  }
  return map;
}

export type CheckStatus =
  | "unchecked"
  | "checking"
  | "passed"
  | "device"
  | "partial"
  | "problems"
  | "stale"
  | "unavailable";

/** Why the last check could not run or finish, or null when it ran. */
export function checkFailure(check: PipelineCheck | null) {
  return (
    check?.diagnostics?.find(
      (item) => item.code && CHECK_FAILURES.has(item.code),
    )?.message || null
  );
}

/**
 * The Check button's state. `device`: Vector accepted the draft and each
 * device still checks its own environment. `partial`: only the structure was
 * checked because no Vector checker is configured.
 */
export function checkStatus({
  checking,
  check,
  stale,
  errors,
  failed = false,
}: {
  checking: boolean;
  check: PipelineCheck | null;
  stale: boolean;
  errors: number;
  /** The last check request failed before a result arrived. */
  failed?: boolean;
}): CheckStatus {
  if (checking) return "checking";
  if (failed) return "unavailable";
  if (!check) return errors ? "problems" : "unchecked";
  if (stale) return errors ? "problems" : "stale";
  if (errors) return "problems";
  if (checkFailure(check)) return "unavailable";
  if (!check.valid) return "problems";
  if (!check.static_checked) return "partial";
  return check.vector_validated ? "passed" : "device";
}

/** Why a check request failed, in words for the Problems panel. */
export function checkFailureMessage(failure: unknown) {
  const error = failure as { status?: number; code?: string; message?: string };
  if (failure instanceof TypeError || error?.status === 0)
    return "Couldn't reach Vectory, so this draft hasn't been checked. Check your connection and try again.";
  if (
    error?.status === 503 ||
    error?.code === "CAPABILITY_DENIED" ||
    error?.code === "WORKER_BUSY"
  )
    return "Vector's checker isn't reachable, so this draft hasn't been checked. Publishing waits for a successful check.";
  return `Couldn't check with Vector: ${error?.message || "unknown error"}`;
}

export function checkLabel(status: CheckStatus, errors: number) {
  switch (status) {
    case "checking":
      return "Checking…";
    case "passed":
    case "device":
      return "Checked";
    case "partial":
      return "Partly checked";
    case "problems":
      return errors === 1 ? "1 problem" : `${errors} problems`;
    case "unavailable":
      return "Couldn't check";
    default:
      return "Not checked";
  }
}

const deferralPhrases: Record<string, string> = {
  "environment variables": "environment variables",
  "native secret references": "secrets",
  "native secret providers": "secrets",
  "device secrets": "secrets",
  "VRL access to device resources": "VRL that reads device resources",
  "Lua runs on devices": "Lua code",
  "native configuration provider": "the configuration provider",
  "device enrichment data": "enrichment data files",
  "Enrichment tables are read on devices": "enrichment data files",
  "device-local paths or external code files": "local files and paths",
};

/** What each device still checks for itself: "secrets and Lua code". */
function deviceChecks(check: Pick<PipelineCheck, "deferred_reasons">) {
  const reasons = [
    ...new Set(
      (check.deferred_reasons || []).map(
        (reason) =>
          deferralPhrases[reason] ||
          reason.replace(
            /^platform-specific source (.+)$/,
            "the $1 source's platform",
          ),
      ),
    ),
  ];
  return reasons.length > 1
    ? `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`
    : reasons[0] || "their environment";
}

/** One-line verdict for a completed check. */
export function checkVerdict(check: PipelineCheck | null, errors: number) {
  if (errors)
    return errors === 1
      ? "1 problem to fix before publishing."
      : `${errors} problems to fix before publishing.`;
  if (!check) return "Run a check to validate this pipeline with Vector.";
  const failure = checkFailure(check);
  if (failure)
    return check.diagnostics?.some(
      (item) => item.code === "validator_unavailable",
    )
      ? "Vector's checker isn't reachable, so this draft hasn't been checked. Publishing waits for a successful check."
      : sentence(failure);
  if (!check.static_checked)
    return "Only the pipeline structure was checked. Each device validates before applying.";
  if (check.vector_validated) return "Vector 0.58 accepted this pipeline.";
  return `Vector 0.58 accepted this pipeline. Each device checks ${deviceChecks(check)} before applying it.`;
}

/** The stored result of the check a version passed when it was published. */
type PublishedCheck = Partial<PipelineCheck> & { vector_version?: string };

/**
 * What a person who can't run a check reads about a draft. One that equals
 * the latest published version was checked when it was published, and the
 * version says so; anything else is simply not checked since the last edit.
 * Never an instruction they can't follow.
 */
export function readOnlyCheck(
  published: { number: number; validation?: PublishedCheck | null } | null,
): { status: CheckStatus; verdict: string } {
  const result = published?.validation;
  if (
    published &&
    result?.valid === true &&
    (result.vector_validated || result.static_checked)
  ) {
    const release = /^\d+\.\d+/.exec(result.vector_version ?? "")?.[0];
    const when = `Version ${published.number} was checked by ${release ? `Vector ${release}` : "Vector"} when it was published.`;
    return result.vector_validated
      ? { status: "passed", verdict: when }
      : {
          status: "device",
          verdict: `${when} Each device checks ${deviceChecks(result)} before applying it.`,
        };
  }
  return { status: "unchecked", verdict: "Not checked since the last edit." };
}

/** Fewest single-character edits between two strings (small inputs only). */
export function editDistance(a: string, b: string) {
  const left = [...a],
    right = [...b];
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++)
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[right.length];
}

/**
 * Whether to offer a fix. Vector's "did you mean" suggestions (labelled
 * "Change to …") are only trustworthy for a near miss: while a name is still
 * being typed the closest known one can be far off, and offering it is noise.
 * Other fixes (add `!`, treat errors as no match) are exact and always shown.
 */
export function fixLooksIntended(
  text: string,
  problem: Pick<Problem, "line" | "column" | "length" | "fix">,
) {
  const { fix, line, column } = problem;
  if (!fix || !/^Change to\b/i.test(fix.label) || fix.scope !== "span")
    return true;
  const current = text.split("\n")[(line ?? 0) - 1];
  if (current === undefined || !column) return true;
  const span = [...current]
    .slice(column - 1, column - 1 + Math.max(0, problem.length ?? 0))
    .join("");
  return editDistance(span, fix.replacement) <= 2;
}

/**
 * Apply a Vector quick fix to a program. `span` replaces `length` characters at
 * 1-based `line:column`; `line` replaces the whole line, keeping indentation.
 * Returns null when the program no longer matches the finding.
 */
export function applyFix(
  text: string,
  problem: Pick<Problem, "line" | "column" | "length" | "fix">,
): string | null {
  const { fix, line, column } = problem;
  if (!fix || !line || line < 1) return null;
  const lines = text.split("\n");
  if (line > lines.length) return null;
  const current = lines[line - 1];
  if (fix.scope === "line") {
    const indent = /^\s*/.exec(current)?.[0] || "";
    lines[line - 1] = indent + fix.replacement.trim();
    return lines.join("\n");
  }
  if (!column || column < 1) return null;
  const characters = [...current];
  const start = column - 1,
    length = Math.max(0, problem.length ?? 0);
  if (start > characters.length) return null;
  characters.splice(start, length, fix.replacement);
  lines[line - 1] = characters.join("");
  return lines.join("\n");
}

/** Findings for one field of one component (VRL program, condition, route). */
export function fieldProblems(
  problems: readonly Problem[],
  component: string,
  field: string,
) {
  return problems.filter(
    (problem) => problem.component === component && problem.field === field,
  );
}
