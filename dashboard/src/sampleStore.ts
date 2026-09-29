/**
 * Named synthetic sample sets, kept in this browser per account and pipeline.
 * Samples are user-written test data; they never come from devices.
 */
export type SampleSet = { id: string; name: string; text: string };
export type SampleStore = {
  version: 1;
  sets: SampleSet[];
  /** Selected set per component ID. */
  active: Record<string, string>;
};

export const MAX_SAMPLE_SETS = 12;
export const MAX_SAMPLE_TEXT = 64 * 1024;

export const DEFAULT_SAMPLE =
  '{"message":"GET /checkout HTTP/1.1 503","status":503,"level":"error","host":"web-01"}\n{"message":"GET /health HTTP/1.1 200","status":200,"level":"debug","host":"web-02"}';

const key = (userId: string, pipelineId: string) =>
  `vectory.samples.v1:${userId}:${pipelineId}`;

export function emptyStore(): SampleStore {
  return {
    version: 1,
    sets: [{ id: "default", name: "Sample events", text: DEFAULT_SAMPLE }],
    active: {},
  };
}

function valid(value: unknown): value is SampleStore {
  if (!value || typeof value !== "object") return false;
  const store = value as SampleStore;
  return (
    store.version === 1 &&
    Array.isArray(store.sets) &&
    store.sets.length > 0 &&
    store.sets.length <= MAX_SAMPLE_SETS &&
    store.sets.every(
      (set) =>
        set &&
        typeof set.id === "string" &&
        typeof set.name === "string" &&
        typeof set.text === "string" &&
        set.text.length <= MAX_SAMPLE_TEXT,
    ) &&
    !!store.active &&
    typeof store.active === "object"
  );
}

export function readSamples(userId: string, pipelineId: string): SampleStore {
  try {
    const raw = localStorage.getItem(key(userId, pipelineId));
    const parsed = raw ? JSON.parse(raw) : null;
    return valid(parsed) ? parsed : emptyStore();
  } catch {
    return emptyStore();
  }
}

/** Returns false when this browser can't keep the samples (private mode, quota). */
export function writeSamples(
  userId: string,
  pipelineId: string,
  store: SampleStore,
): boolean {
  try {
    localStorage.setItem(key(userId, pipelineId), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function activeSet(store: SampleStore, componentId: string): SampleSet {
  return (
    store.sets.find((set) => set.id === store.active[componentId]) ||
    store.sets[0]
  );
}

export function uniqueSetName(store: SampleStore, base = "Samples") {
  let name = base,
    number = 2;
  while (store.sets.some((set) => set.name === name))
    name = `${base} ${number++}`;
  return name;
}

export type ParsedSamples = {
  samples: Record<string, unknown>[];
  /** 1-based line per sample, for error locations and labels. */
  lines: number[];
  errors: { line: number; message: string }[];
};

/**
 * One JSON object per line (JSONL). A whole-document JSON object or array of
 * objects is also accepted, so pasted pretty JSON works.
 */
export function parseSamples(text: string, limit = 20): ParsedSamples {
  const trimmed = text.trim();
  if (!trimmed) return { samples: [], lines: [], errors: [] };
  if (/^[[{]/.test(trimmed) && trimmed.includes("\n")) {
    try {
      const whole = JSON.parse(trimmed);
      const list = Array.isArray(whole) ? whole : [whole];
      if (
        list.every(
          (item) => item && typeof item === "object" && !Array.isArray(item),
        )
      ) {
        const start = text.length - text.trimStart().length;
        const firstLine = text.slice(0, start).split("\n").length;
        return {
          samples: list.slice(0, limit),
          lines: list.slice(0, limit).map(() => firstLine),
          errors:
            list.length > limit
              ? [
                  {
                    line: firstLine,
                    message: `Only the first ${limit} samples run.`,
                  },
                ]
              : [],
        };
      }
    } catch {
      /* fall back to JSON lines */
    }
  }
  const samples: Record<string, unknown>[] = [];
  const lines: number[] = [];
  const errors: { line: number; message: string }[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        errors.push({
          line: index + 1,
          message: "Each line must be one JSON object.",
        });
      else if (samples.length >= limit)
        errors.push({
          line: index + 1,
          message: `Only the first ${limit} samples run.`,
        });
      else {
        samples.push(value);
        lines.push(index + 1);
      }
    } catch (error) {
      errors.push({
        line: index + 1,
        message: `Not valid JSON: ${(error as Error).message.replace(/^JSON\.parse: /, "")}`,
      });
    }
  });
  return { samples, lines, errors };
}
