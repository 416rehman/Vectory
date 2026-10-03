import { describe, expect, it } from "vitest";
import {
  attemptView,
  ChannelListSchema,
  channelRequest,
  channelStatus,
  DetectionSchema,
  destination,
  draftFromChannel,
  eventLabel,
  filtersSummary,
  newDraft,
  parseRecipients,
  rulesSummary,
  detectionFields,
  sameThresholds,
  thresholdErrors,
  thresholdForm,
  thresholdHint,
  thresholdUnit,
  thresholdValues,
  validateDraft,
  webhookUrlError,
  type Attempt,
  type Channel,
  type ChannelDraft,
  type Rules,
} from "./notificationsModel";

const rules = (patch: Partial<Rules> = {}): Rules => ({
  events: ["issue.opened"],
  offline_minutes: 15,
  min_severity: "warning",
  pipeline_ids: [],
  group_ids: [],
  quiet_hours: null,
  ...patch,
});
const channel = (patch: Partial<Channel> = {}): Channel => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Ops Slack",
  kind: "webhook",
  enabled: true,
  allow_private: false,
  webhook: {
    url_hint: "https://hooks.slack.com/…",
    host: "hooks.slack.com",
    header_name: "Authorization",
    signing_secret_set: true,
    header_value_set: true,
  },
  email: null,
  rules: rules(),
  secrets_readable: true,
  revision: 3,
  created_at: "2026-09-29T10:00:00Z",
  updated_at: "2026-09-29T10:00:00Z",
  status: {
    state: "idle",
    last_attempt_at: null,
    last_delivered_at: null,
    last_error: null,
    last_status_code: null,
    pending: 0,
  },
  ...patch,
});
const attempt = (patch: Partial<Attempt> = {}): Attempt => ({
  id: 1,
  delivery_id: "d",
  channel_id: "c",
  channel_name: "Ops Slack",
  channel_exists: true,
  kind: "event",
  type: "issue.opened",
  title: "Issue on web-1: archive can't deliver events",
  attempt: 1,
  at: "2026-09-29T10:00:00Z",
  outcome: "delivered",
  status_code: 200,
  latency_ms: 182,
  error: null,
  next_attempt_at: null,
  ...patch,
});
const webhookDraft = (patch: Partial<ChannelDraft> = {}): ChannelDraft => ({
  ...newDraft("webhook", "Europe/Berlin"),
  name: "Ops Slack",
  url: { state: "set", value: "https://hooks.slack.com/services/T0/B0/x" },
  ...patch,
});

describe("channel summaries", () => {
  it("reads rules as a short sentence", () => {
    expect(
      rulesSummary(rules({ events: ["issue.opened", "issue.resolved"] })),
    ).toBe("Issues and resolutions");
    expect(
      rulesSummary(
        rules({
          events: [
            "issue.resolved",
            "rollout.failed",
            "rollout.rolled_back",
            "canary.paused",
            "device.offline",
            "device.recovered",
          ],
          offline_minutes: 60,
        }),
      ),
    ).toBe(
      "Resolved issues, rollout problems, offline after 1 hour and back online",
    );
    expect(rulesSummary(rules({ events: ["rollout.failed"] }))).toBe(
      "Failed rollouts",
    );
    expect(rulesSummary(rules({ events: ["device.recovered"] }))).toBe(
      "Devices back online",
    );
  });

  it("lists only the filters that narrow a channel", () => {
    expect(filtersSummary(rules())).toBe("");
    expect(
      filtersSummary(
        rules({
          min_severity: "error",
          pipeline_ids: ["a", "b"],
          group_ids: ["g"],
          quiet_hours: {
            start: "22:00",
            end: "07:00",
            time_zone: "Europe/Berlin",
            errors_bypass: true,
          },
        }),
      ),
    ).toBe(
      "Errors only · 2 pipelines · 1 group · Quiet 22:00–07:00 (Europe/Berlin)",
    );
  });

  it("names where a channel sends without secrets", () => {
    expect(destination(channel())).toBe("hooks.slack.com");
    expect(
      destination(
        channel({
          kind: "email",
          webhook: null,
          email: {
            host: "smtp.example.com",
            port: 587,
            security: "starttls",
            username: null,
            password_set: false,
            from: "alerts@example.com",
            to: ["a@example.com", "b@example.com"],
          },
        }),
      ),
    ).toBe("2 recipients via smtp.example.com");
  });

  it("says how a channel is doing, never claiming a delivery it didn't make", () => {
    const now = Date.parse("2026-09-29T10:05:00Z");
    expect(channelStatus(channel(), now)).toEqual({
      tone: "neutral",
      label: "No messages yet",
      detail: "Send a test to check it",
    });
    expect(
      channelStatus(
        channel({
          status: {
            ...channel().status,
            state: "delivering",
            last_delivered_at: "2026-09-29T10:03:00Z",
            pending: 2,
          },
        }),
        now,
      ),
    ).toEqual({
      tone: "success",
      label: "Delivering",
      detail: "Last delivered 2m ago · 2 waiting",
    });
    expect(
      channelStatus(
        channel({
          status: {
            ...channel().status,
            state: "failing",
            last_error:
              "Connection refused by hooks.example.com (10.0.0.5:443).",
          },
        }),
        now,
      ),
    ).toMatchObject({
      tone: "danger",
      label: "Failing",
      detail: "Connection refused by hooks.example.com (10.0.0.5:443).",
    });
    expect(channelStatus(channel({ enabled: false }), now).label).toBe("Off");
    expect(channelStatus(channel({ secrets_readable: false }), now).label).toBe(
      "Needs secrets",
    );
  });

  it("parses the channel list contract", () => {
    expect(
      ChannelListSchema.safeParse({ items: [channel()], max_channels: 20 })
        .success,
    ).toBe(true);
    expect(
      ChannelListSchema.safeParse({
        items: [{ ...channel(), kind: "pager" }],
        max_channels: 20,
      }).success,
    ).toBe(false);
  });
});

describe("delivery log", () => {
  const time = () => "12:31";
  it("labels every outcome with what happened", () => {
    expect(attemptView(attempt(), time)).toEqual({
      tone: "success",
      label: "Delivered",
      detail: "Answered 200 in 182 ms",
    });
    expect(
      attemptView(
        attempt({
          outcome: "retrying",
          status_code: 503,
          error: "The receiver answered 503 Service Unavailable.",
          next_attempt_at: "x",
        }),
        time,
      ),
    ).toEqual({
      tone: "warning",
      label: "Retrying",
      detail: "The receiver answered 503 Service Unavailable. Next try 12:31.",
    });
    expect(
      attemptView(
        attempt({ outcome: "gave_up", attempt: 4, error: "Timed out." }),
        time,
      ).detail,
    ).toBe("Timed out. No more tries after 4 attempts.");
    // One attempt is one attempt.
    expect(
      attemptView(
        attempt({ outcome: "gave_up", attempt: 1, error: "Timed out." }),
        time,
      ).detail,
    ).toBe("Timed out. No more tries after 1 attempt.");
    expect(
      attemptView(
        attempt({
          outcome: "failed",
          error: "The receiver answered 404 Not Found.",
        }),
        time,
      ).detail,
    ).toContain("Not retried");
    expect(
      attemptView(
        attempt({ kind: "test", outcome: "failed", error: "Refused." }),
        time,
      ).detail,
    ).toBe("Refused.");
  });

  it("names tests and summaries", () => {
    expect(eventLabel("test")).toBe("Test message");
    expect(eventLabel("digest")).toBe("Summary");
    expect(eventLabel("device.recovered")).toBe("Device back online");
  });
});

describe("channel form", () => {
  it("refuses webhook URLs the server would refuse", () => {
    expect(webhookUrlError("", false)).toBe("Enter the webhook URL.");
    expect(webhookUrlError("hooks.slack.com/services/x", false)).toContain(
      "full URL",
    );
    expect(webhookUrlError("http://10.0.0.5/hook", false)).toContain(
      "Use https://",
    );
    expect(webhookUrlError("http://10.0.0.5/hook", true)).toBe("");
    expect(
      webhookUrlError("https://user:pw@hooks.example.com/", false),
    ).toContain("user name and password");
    expect(webhookUrlError("https://hooks.example.com/#x", false)).toContain(
      "#fragment",
    );
    expect(webhookUrlError("https://169.254.169.254/latest", true)).toContain(
      "never contacts",
    );
    expect(webhookUrlError("https://localhost:9000/hook", false)).toContain(
      "Allow private network addresses",
    );
    expect(webhookUrlError("https://192.168.1.20/hook", true)).toBe("");
    expect(
      webhookUrlError("https://hooks.slack.com/services/T0/B0/x", false),
    ).toBe("");
  });

  it("checks every field before sending", () => {
    expect(validateDraft(webhookDraft())).toEqual({});
    const errors = validateDraft(
      webhookDraft({
        name: " ",
        signingSecret: { state: "set", value: "short" },
        headerName: "Content-Type",
        events: [],
        offlineMinutes: "2",
        quiet: true,
        quietStart: "22:00",
        quietEnd: "22:00",
      }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      "events",
      "headerName",
      "headerValue",
      "name",
      "quietStart",
      "signingSecret",
    ]);
    expect(
      validateDraft(
        webhookDraft({ events: ["device.offline"], offlineMinutes: "1441" }),
      ).offlineMinutes,
    ).toContain("1,440");
    expect(
      validateDraft(webhookDraft({ headerName: "Authorization" })).headerValue,
    ).toBe("Enter the header's value.");
    const email: ChannelDraft = {
      ...newDraft("email", "UTC"),
      name: "Mail",
      host: "smtp.example.com:587",
      port: "0",
      username: "alerts",
      from: "not-an-address",
      to: "oncall@example.com, nope",
      security: "none",
    };
    expect(Object.keys(validateDraft(email)).sort()).toEqual([
      "from",
      "host",
      "password",
      "port",
      "security",
      "to",
    ]);
    expect(
      validateDraft({
        ...email,
        host: "localhost",
        port: "25",
        security: "none",
        allowPrivate: true,
        username: "",
        from: "Vectory <alerts@example.com>",
        to: "oncall@example.com",
      }),
    ).toEqual({});
  });

  it("sends secrets only when they change", () => {
    const edit = draftFromChannel(channel(), "UTC");
    const kept = channelRequest(edit, 3);
    expect(kept).toMatchObject({
      revision: 3,
      webhook: { header_name: "Authorization" },
    });
    expect(kept.webhook).not.toHaveProperty("url");
    expect(kept.webhook).not.toHaveProperty("signing_secret");
    expect(kept.webhook).not.toHaveProperty("header_value");
    const changed = channelRequest(
      {
        ...edit,
        url: { state: "set", value: " https://hooks.slack.com/services/new " },
        signingSecret: { state: "remove" },
        headerValue: { state: "set", value: "Bearer next" },
      },
      3,
    );
    expect(changed.webhook).toEqual({
      url: "https://hooks.slack.com/services/new",
      signing_secret: null,
      header_name: "Authorization",
      header_value: "Bearer next",
    });
    const cleared = channelRequest({ ...edit, headerName: "" }, 3);
    expect(cleared.webhook).toEqual({ header_name: null });
  });

  it("builds rules in the documented order", () => {
    const body = channelRequest(
      webhookDraft({
        events: ["device.offline", "issue.opened"],
        offlineMinutes: "30",
        errorsOnly: true,
        quiet: true,
        timeZone: "Europe/Berlin",
      }),
    );
    expect(body.rules).toEqual({
      events: ["issue.opened", "device.offline"],
      offline_minutes: 30,
      min_severity: "error",
      pipeline_ids: [],
      group_ids: [],
      quiet_hours: {
        start: "22:00",
        end: "07:00",
        time_zone: "Europe/Berlin",
        errors_bypass: true,
      },
    });
    expect(body).not.toHaveProperty("revision");
  });

  it("omits a password without a user name", () => {
    const body = channelRequest({
      ...newDraft("email", "UTC"),
      name: "Mail",
      host: "smtp.example.com",
      password: { state: "set", value: "secret" },
      from: "alerts@example.com",
      to: "a@example.com; b@example.com",
    });
    expect(body.email).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: null,
      from: "alerts@example.com",
      to: ["a@example.com", "b@example.com"],
    });
    expect(parseRecipients(" a@x.io,b@x.io \n c@x.io ")).toEqual([
      "a@x.io",
      "b@x.io",
      "c@x.io",
    ]);
  });
});

describe("detection thresholds", () => {
  const detection = DetectionSchema.parse({
    thresholds: {
      sink_errors_per_minute: 5,
      error_drops_per_minute: 1,
      buffer_full_percent: 90,
      stall_checks: 3,
      canary_checks: 3,
    },
    defaults: {
      sink_errors_per_minute: 1,
      error_drops_per_minute: 1,
      buffer_full_percent: 95,
      stall_checks: 3,
      canary_checks: 3,
    },
    bounds: {
      sink_errors_per_minute: { min: 1, max: 10000 },
      error_drops_per_minute: { min: 1, max: 100000 },
      buffer_full_percent: { min: 55, max: 100 },
      stall_checks: { min: 2, max: 20 },
      canary_checks: { min: 1, max: 20 },
    },
    revision: 2,
    updated_at: "2026-09-29T10:00:00Z",
    updated_by_name: "Alex",
    evaluation_interval_seconds: 25,
  });

  it("checks each value against the server's bounds", () => {
    const form = thresholdForm(detection.thresholds);
    expect(thresholdErrors(form, detection)).toEqual({});
    expect(
      thresholdErrors(
        {
          ...form,
          buffer_full_percent: "50",
          stall_checks: "2.5",
          canary_checks: "",
        },
        detection,
      ),
    ).toEqual({
      buffer_full_percent: "Enter a whole number from 55 to 100.",
      stall_checks: "Enter a whole number from 2 to 20.",
      canary_checks: "Enter a whole number from 1 to 20.",
    });
  });

  it("compares values, not text", () => {
    const form = thresholdForm(detection.thresholds);
    expect(sameThresholds(thresholdValues(form), detection.thresholds)).toBe(
      true,
    );
    expect(
      sameThresholds(
        thresholdValues({ ...form, sink_errors_per_minute: "05" }),
        detection.thresholds,
      ),
    ).toBe(true);
    expect(sameThresholds(detection.defaults, detection.thresholds)).toBe(
      false,
    );
  });

  it("says each unit in the singular after one", () => {
    const [sink, , buffer, stall] = detectionFields;
    expect(thresholdUnit(sink, "1")).toBe("failed request a minute");
    expect(thresholdUnit(sink, " 1 ")).toBe("failed request a minute");
    expect(thresholdUnit(sink, "20")).toBe("failed requests a minute");
    expect(thresholdUnit(stall, "")).toBe("checks in a row");
    expect(thresholdUnit(buffer, "1")).toBe("% full");
  });

  it("names the default and the allowed range under each value", () => {
    const [sink, , buffer] = detectionFields;
    expect(thresholdHint(sink, "5", detection)).toBe(
      "Default 1 · allowed 1 to 10,000",
    );
    expect(thresholdHint(buffer, " 95 ", detection)).toBe(
      "The default · allowed 55 to 100",
    );
  });
});
