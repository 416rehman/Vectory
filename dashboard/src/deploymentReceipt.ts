import {
  DeploymentReceiptSchema,
  DeploymentRequestLookupSchema,
  type DeploymentReceipt,
  type DeploymentRequestLookup,
} from "./api";
import type { DeploymentOperation } from "./deploymentRequests";

const unavailableIdentity =
  "The server could not confirm this request's identity. Your reminder is still saved. Update the server or check deployment history before trying again.";
const mismatchedIdentity =
  "The response identifies a different deployment request. Your reminder is still saved. Check its status again before sending another request.";
const sameId = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

function matchesOperation(
  operation: DeploymentOperation,
  receipt: Pick<
    DeploymentReceipt,
    "request_id" | "operation" | "source_deployment_id"
  >,
) {
  return (
    sameId(receipt.request_id, operation.id) &&
    receipt.operation === operation.kind &&
    (operation.kind === "create"
      ? receipt.source_deployment_id === null
      : receipt.source_deployment_id !== null &&
        sameId(receipt.source_deployment_id, operation.deployment_id))
  );
}

/** Correlate immutable request identity, not the result's mutable current state. */
export function assertDeploymentReceipt(
  operation: DeploymentOperation,
  value: unknown,
): DeploymentReceipt {
  const parsed = DeploymentReceiptSchema.safeParse(value);
  if (!parsed.success) throw Error(unavailableIdentity);
  const receipt = parsed.data;
  if (
    !matchesOperation(operation, receipt) ||
    (operation.kind === "rollback" &&
      sameId(receipt.id, operation.deployment_id))
  )
    throw Error(mismatchedIdentity);
  return receipt;
}

/** A missing result proves compatibility only when its exact key is echoed. */
export function assertDeploymentLookup(
  operation: DeploymentOperation,
  value: unknown,
): DeploymentRequestLookup {
  const result = assertDeploymentLookupById(operation.id, value);
  if (result.found) {
    if (!matchesOperation(operation, result)) throw Error(mismatchedIdentity);
    assertDeploymentReceipt(operation, result.deployment);
  }
  return result;
}

/** Unreadable local payloads support status only, never reconstructed retries. */
export function assertDeploymentLookupById(
  requestId: string,
  value: unknown,
): DeploymentRequestLookup {
  const parsed = DeploymentRequestLookupSchema.safeParse(value);
  if (!parsed.success) throw Error(unavailableIdentity);
  const result = parsed.data;
  if (!sameId(result.request_id, requestId)) throw Error(mismatchedIdentity);
  return result;
}
