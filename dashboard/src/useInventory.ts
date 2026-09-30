import { useEffect, useMemo, useState } from "react";
import { useResource } from "./ui";
import {
  emptyInventory,
  inventoryPath,
  type InventoryPage,
  type InventoryQuery,
} from "./deviceInventory";

/**
 * One page of the device inventory. A new page, sort or search keeps the rows
 * of the last answer on screen (`settling`) until it answers, so paging never
 * flashes an empty table.
 */
export function useInventory(request: InventoryQuery, interval?: number) {
  const page = request.page ?? 1;
  const size = request.size ?? 50;
  const initial = useMemo(() => emptyInventory(page, size), [page, size]);
  const resource = useResource<InventoryPage>(
    inventoryPath(request),
    initial,
    0,
    interval === undefined ? {} : { interval },
  );
  const [kept, setKept] = useState<InventoryPage | null>(null);
  useEffect(() => {
    if (resource.updatedAt) setKept(resource.data);
  }, [resource.updatedAt, resource.data]);
  return {
    resource,
    data: resource.updatedAt ? resource.data : (kept ?? resource.data),
    /** Some page has been read, this one or an earlier one. */
    loaded: !!resource.updatedAt || !!kept,
    /** The rows shown are the last answer's; this page hasn't answered yet. */
    settling: !resource.updatedAt && !!kept,
  };
}
