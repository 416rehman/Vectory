import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { APIError, api, invalidateSession, setCSRF } from "./api";

const requested = "aaaaaaaa-1111-4111-8111-111111111111";
const unrelated = "bbbbbbbb-2222-4222-8222-222222222222";
const device = (id = requested) => ({
  id,
  name: "Synthetic selected device",
  status: "online",
  apply_state: "applied",
  desired_generation: 3,
  reported_generation: 3,
});
const configuration = (id = requested) => ({
  id,
  name: "Synthetic pipeline",
  revision: 1,
  config: {},
  graph: { nodes: [], edges: [] },
});
const cases = [
  {
    label: "device detail",
    path: `/devices/${requested}`,
    method: "GET",
    value: device,
  },
  {
    label: "device telemetry",
    path: `/devices/${requested}/telemetry`,
    method: "GET",
    value: (id: string) => ({ device_id: id, samples: [] }),
  },
  {
    label: "retry receipt",
    path: `/devices/${requested}/retry`,
    method: "POST",
    value: device,
  },
  {
    label: "immutable version",
    path: `/versions/${requested}`,
    method: "GET",
    value: (id: string) => ({ id, configuration_id: unrelated, number: 2 }),
  },
  {
    label: "pipeline draft",
    path: `/configurations/${requested}`,
    method: "GET",
    value: configuration,
  },
];

function reply(value: unknown, status = 200) {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(value), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function expectIdentityFailure(pending: Promise<unknown>) {
  const failure = await pending.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(APIError);
  expect(failure).toMatchObject({
    code: "IDENTITY_MISMATCH",
    status: 502,
    serverRejection: false,
  });
  const message = (failure as Error).message;
  expect(message).not.toContain(requested);
  expect(message).not.toContain(unrelated);
  return message;
}

beforeEach(() => setCSRF("synthetic-response-identity-session"));
afterEach(() => {
  setCSRF("");
  vi.unstubAllGlobals();
});

describe("requested resource identity at the real API boundary", () => {
  it.each(cases)("accepts the exact $label identity", async (test) => {
    reply(test.value(requested));
    await expect(
      api(test.path, { method: test.method }),
    ).resolves.toMatchObject(test.value(requested));
  });

  it.each(cases)(
    "rejects a valid-shaped $label for a different resource",
    async (test) => {
      reply(test.value(unrelated));
      await expectIdentityFailure(api(test.path, { method: test.method }));
    },
  );

  it.each(["", ` ${requested}`, `${requested} `, requested.toUpperCase()])(
    "does not trim or case-fold a returned identity (%j)",
    async (id) => {
      reply(device(id));
      await expectIdentityFailure(api(`/devices/${requested}`));
    },
  );

  it("compares one decoded path segment while ignoring query values", async () => {
    const path = `/devices/%61${requested.slice(1)}?selected=${unrelated}`;
    const fetch = reply(device());
    await expect(api(path)).resolves.toMatchObject({ id: requested });
    expect(fetch.mock.calls[0][0]).toBe(`/api/v1${path}`);
  });

  it("does not decode a path segment twice", async () => {
    reply(device());
    await expectIdentityFailure(api(`/devices/%2561${requested.slice(1)}`));
  });

  it.each(["%", "%GG", "%E0%A4"])(
    "fails closed on malformed percent encoding (%s)",
    async (segment) => {
      reply(device());
      await expectIdentityFailure(api(`/devices/${segment}`));
    },
  );

  it("cannot bypass correlation with a lowercase HTTP method", async () => {
    reply(device(unrelated));
    await expectIdentityFailure(
      api(`/devices/${requested}`, { method: "get" }),
    );
  });

  it("does not let a schema override hide a missing identity", async () => {
    reply({ name: "No identity" });
    await expectIdentityFailure(api(`/devices/${requested}`, {}, z.unknown()));
  });

  it("checks the raw receipt even when a schema transform forges the expected identity", async () => {
    reply(device(unrelated));
    await expectIdentityFailure(
      api(
        `/devices/${requested}`,
        {},
        z.unknown().transform(() => ({ id: requested })),
      ),
    );
  });

  it("permits a caller to project a valid correlated response without keeping its identity field", async () => {
    reply(device());
    await expect(
      api(`/devices/${requested}`, {}, z.object({ name: z.string() })),
    ).resolves.toEqual({ name: "Synthetic selected device" });
  });

  it.each([{}, null, [], { id: 17 }])(
    "rejects a missing or non-string version identity without a default shape schema (%j)",
    async (value) => {
      reply(value);
      await expectIdentityFailure(api(`/versions/${requested}`));
    },
  );

  it("retains existing shape validation precedence for a missing Device.id", async () => {
    const { id: _id, ...value } = device();
    reply(value);
    await expect(api(`/devices/${requested}`)).rejects.toMatchObject({
      code: "CONTRACT_MISMATCH",
      status: 502,
      serverRejection: false,
    });
  });

  it("retains shape validation precedence when both shape and identity are wrong", async () => {
    reply({ id: unrelated });
    await expect(api(`/devices/${requested}`)).rejects.toMatchObject({
      code: "CONTRACT_MISMATCH",
    });
  });

  it.each(["library", "requests", "publish-requests"])(
    "does not treat the static configuration %s page as a draft identity",
    async (route) => {
      const page = { items: [], total: 0, page: 1, page_size: 12 };
      reply(page);
      await expect(
        api(`/configurations/${route}?page=1&page_size=12`),
      ).resolves.toEqual(page);
    },
  );

  it.each([
    { path: "/devices", method: "GET", value: [device(unrelated)] },
    {
      path: "/configurations",
      method: "GET",
      value: [configuration(unrelated)],
    },
    {
      path: "/configurations",
      method: "POST",
      value: configuration(unrelated),
    },
    {
      path: `/configurations/${requested}/duplicate`,
      method: "POST",
      value: configuration(unrelated),
    },
    {
      path: `/devices/${requested}/recover`,
      method: "POST",
      value: { request_id: unrelated, record: { id: unrelated } },
    },
  ])("preserves $method $path response semantics", async (test) => {
    reply(test.value);
    await expect(
      api(test.path, { method: test.method }),
    ).resolves.toMatchObject(test.value);
  });

  it("does not replace an authoritative HTTP rejection with an identity error", async () => {
    reply(
      { error: { code: "NOT_FOUND", message: "Resource unavailable" } },
      404,
    );
    await expect(api(`/devices/${requested}`)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      serverRejection: true,
    });
  });

  it("retains unreadable-body precedence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{")));
    await expect(api(`/devices/${requested}`)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a held mismatched body through session invalidation before accepting any response", async () => {
    let deliver!: (body: string) => void;
    const text = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          deliver = resolve;
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text }),
    );
    const accepted = vi.fn();
    const pending = api(`/devices/${requested}`)
      .then(accepted)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
    invalidateSession();
    expect(await pending).toMatchObject({ code: "SESSION_ENDED", status: 0 });
    deliver(JSON.stringify(device(unrelated)));
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
  });
});
