import { Hono } from "hono";
import {
  approvalSchema,
  createMissionSchema,
  missionEventSchema,
  type BrowserAction
} from "@neptune/protocol";
import { buildMissionPlan } from "./planner";
export { MissionRoom } from "./mission-room";

interface Env {
  DB: D1Database;
  MISSION_ROOM: DurableObjectNamespace;
  AGENT_API_TOKEN: string;
  APP_ENV: string;
  ALLOWED_ORIGINS: string;
}

type Variables = {
  requestId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
});

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = new Set((c.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()));
  if (origin && allowed.has(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Headers", "authorization,content-type");
    c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/health", (c) => c.json({
  service: "neptune-agent-api",
  status: "ok",
  environment: c.env.APP_ENV,
  now: new Date().toISOString()
}));

app.use("/v1/*", async (c, next) => {
  const expected = c.env.AGENT_API_TOKEN;
  const authorization = c.req.header("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!expected || provided.length < 24 || provided !== expected) {
    return c.json({ error: "unauthorized", requestId: c.get("requestId") }, 401);
  }

  await next();
});

app.post("/v1/missions", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const parsed = createMissionSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const missionId = crypto.randomUUID();
  const actions = buildMissionPlan(parsed.data);
  const status = actions.some((item) => item.type === "ASK_APPROVAL")
    ? "awaiting_approval"
    : "planned";

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO missions (id, device_id, goal, status, context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      missionId,
      parsed.data.deviceId,
      parsed.data.goal,
      status,
      JSON.stringify(parsed.data.context),
      now,
      now
    )
  ];

  for (const [position, action] of actions.entries()) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO mission_actions
          (id, mission_id, position, type, label, risk, requires_approval, payload_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        action.id,
        missionId,
        position,
        action.type,
        action.label,
        action.risk,
        action.requiresApproval ? 1 : 0,
        JSON.stringify({ target: action.target, value: action.value, url: action.url, delayMs: action.delayMs }),
        action.status,
        now,
        now
      )
    );
  }

  await c.env.DB.batch(statements);
  await publishToDevice(c.env, parsed.data.deviceId, {
    type: "MISSION_CREATED",
    missionId,
    status,
    actions
  });

  return c.json({
    id: missionId,
    goal: parsed.data.goal,
    deviceId: parsed.data.deviceId,
    status,
    actions,
    createdAt: now,
    updatedAt: now
  }, 201);
});

app.get("/v1/missions/:missionId", async (c) => {
  const missionId = c.req.param("missionId");
  const mission = await c.env.DB.prepare(
    `SELECT id, device_id, goal, status, context_json, created_at, updated_at
     FROM missions WHERE id = ?`
  ).bind(missionId).first<Record<string, string>>();

  if (!mission) return c.json({ error: "mission_not_found" }, 404);

  const actionRows = await c.env.DB.prepare(
    `SELECT id, type, label, risk, requires_approval, payload_json, status
     FROM mission_actions WHERE mission_id = ? ORDER BY position ASC`
  ).bind(missionId).all<Record<string, string | number>>();

  return c.json({
    id: mission.id,
    deviceId: mission.device_id,
    goal: mission.goal,
    status: mission.status,
    context: safeJson(mission.context_json),
    actions: actionRows.results.map(rowToAction),
    createdAt: mission.created_at,
    updatedAt: mission.updated_at
  });
});

app.post("/v1/missions/:missionId/approvals", async (c) => {
  const missionId = c.req.param("missionId");
  const payload = await c.req.json().catch(() => null);
  const parsed = approvalSchema.safeParse({ ...payload, missionId });
  if (!parsed.success) {
    return c.json({ error: "invalid_approval", details: parsed.error.flatten() }, 400);
  }
  if (new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
    return c.json({ error: "approval_already_expired" }, 400);
  }

  const mission = await c.env.DB.prepare(
    "SELECT device_id FROM missions WHERE id = ?"
  ).bind(missionId).first<{ device_id: string }>();
  if (!mission) return c.json({ error: "mission_not_found" }, 404);

  const now = new Date().toISOString();
  const approvalId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO approvals
        (id, mission_id, action_ids_json, approved, expires_at, message_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      approvalId,
      missionId,
      JSON.stringify(parsed.data.actionIds),
      parsed.data.approved ? 1 : 0,
      parsed.data.expiresAt,
      parsed.data.messageHash ?? null,
      now
    ),
    c.env.DB.prepare(
      "UPDATE missions SET status = ?, updated_at = ? WHERE id = ?"
    ).bind(parsed.data.approved ? "planned" : "cancelled", now, missionId)
  ]);

  await publishToDevice(c.env, mission.device_id, {
    type: parsed.data.approved ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
    missionId,
    approvalId,
    actionIds: parsed.data.actionIds,
    expiresAt: parsed.data.expiresAt
  });

  return c.json({ id: approvalId, ...parsed.data, createdAt: now }, 201);
});

app.post("/v1/missions/:missionId/events", async (c) => {
  const missionId = c.req.param("missionId");
  const payload = await c.req.json().catch(() => null);
  const parsed = missionEventSchema.safeParse({ ...payload, missionId });
  if (!parsed.success) {
    return c.json({ error: "invalid_event", details: parsed.error.flatten() }, 400);
  }

  const mission = await c.env.DB.prepare(
    "SELECT device_id FROM missions WHERE id = ?"
  ).bind(missionId).first<{ device_id: string }>();
  if (!mission) return c.json({ error: "mission_not_found" }, 404);

  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, mission_id, action_id, event_type, payload_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    missionId,
    parsed.data.actionId ?? null,
    parsed.data.type,
    JSON.stringify(parsed.data.payload),
    parsed.data.occurredAt
  ).run();

  if (parsed.data.actionId) {
    const nextStatus = parsed.data.type === "ACTION_COMPLETED"
      ? "completed"
      : parsed.data.type === "ACTION_FAILED"
        ? "failed"
        : parsed.data.type === "ACTION_STARTED"
          ? "running"
          : null;
    if (nextStatus) {
      await c.env.DB.prepare(
        "UPDATE mission_actions SET status = ?, updated_at = ? WHERE id = ? AND mission_id = ?"
      ).bind(nextStatus, parsed.data.occurredAt, parsed.data.actionId, missionId).run();
    }
  }

  if (parsed.data.type === "MISSION_COMPLETED") {
    await c.env.DB.prepare(
      "UPDATE missions SET status = 'completed', updated_at = ? WHERE id = ?"
    ).bind(parsed.data.occurredAt, missionId).run();
  }

  await publishToDevice(c.env, mission.device_id, parsed.data);
  return c.json({ accepted: true }, 202);
});

app.get("/v1/realtime/:deviceId", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "websocket_upgrade_required" }, 426);
  }
  const id = c.env.MISSION_ROOM.idFromName(c.req.param("deviceId"));
  return c.env.MISSION_ROOM.get(id).fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error("Unhandled Neptune Agent API error", error);
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

function rowToAction(row: Record<string, string | number>): BrowserAction {
  const payload = safeJson(String(row.payload_json)) as Record<string, unknown>;
  return {
    id: String(row.id),
    type: row.type as BrowserAction["type"],
    label: String(row.label),
    risk: row.risk as BrowserAction["risk"],
    requiresApproval: Number(row.requires_approval) === 1,
    status: row.status as BrowserAction["status"],
    ...(payload.target ? { target: payload.target as BrowserAction["target"] } : {}),
    ...(typeof payload.value === "string" ? { value: payload.value } : {}),
    ...(typeof payload.url === "string" ? { url: payload.url } : {}),
    ...(typeof payload.delayMs === "number" ? { delayMs: payload.delayMs } : {})
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function publishToDevice(env: Env, deviceId: string, payload: unknown): Promise<void> {
  const id = env.MISSION_ROOM.idFromName(deviceId);
  const stub = env.MISSION_ROOM.get(id);
  await stub.fetch("https://mission-room.internal/broadcast", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export default app;
