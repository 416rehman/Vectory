import {
  Ban,
  CalendarX,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CircleX,
  KeyRound,
  Layers,
  LoaderCircle,
  Pause,
  Play,
  Rocket,
  RotateCcw,
  RotateCw,
  Server,
  SlidersHorizontal,
  Upload,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  activityGlyph,
  activityTone,
  type ActivityGlyph as Glyph,
  type ActivityItem,
} from "./activityModel";

const icons: Record<Glyph, LucideIcon> = {
  publish: Upload,
  pipeline: Workflow,
  deploy: Rocket,
  rollback: RotateCcw,
  pause: Pause,
  resume: Play,
  cancel: CircleMinus,
  missed: CalendarX,
  applied: CircleCheck,
  failed: CircleX,
  check: CircleHelp,
  progress: LoaderCircle,
  enroll: Server,
  revoke: Ban,
  retry: RotateCw,
  recovery: KeyRound,
  group: Layers,
  settings: SlidersHorizontal,
  token: KeyRound,
  issue: CircleAlert,
  other: CircleDot,
};

/** A decorative per-event icon in the event's status tone. */
export default function ActivityGlyph({ item }: { item: ActivityItem }) {
  const Icon = icons[activityGlyph(item)];
  return (
    <span
      className="activity-glyph"
      data-tone={activityTone(item)}
      aria-hidden="true"
    >
      <Icon size={13} strokeWidth={2.1} />
    </span>
  );
}
