import { lazy, Suspense, type ComponentProps } from "react";
import type TargetDialogView from "./TargetDialog";
import { ChunkBoundary, DialogLoading, DialogRecovery } from "./PageBoundary";
import { loadPage } from "./pageLoading";

const load = () => import("./TargetDialog");
const TargetDialogChunk = lazy(() => loadPage(load));

/** Start downloading the deploy dialog before it opens. */
export function prefetchTargetDialog() {
  void load().catch(() => {});
}

/**
 * The deploy and apply dialog. It only ever renders open, so it downloads
 * when it first opens instead of with every page that can open it.
 */
export default function TargetDialog(
  props: ComponentProps<typeof TargetDialogView>,
) {
  return (
    <ChunkBoundary
      fallback={(kind) => <DialogRecovery kind={kind} onClose={props.onClose} />}
    >
      <Suspense fallback={<DialogLoading />}>
        <TargetDialogChunk {...props} />
      </Suspense>
    </ChunkBoundary>
  );
}
