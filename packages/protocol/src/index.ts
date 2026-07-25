import { z } from "zod";

export const actionTypeSchema = z.enum([
  "OPEN_URL",
  "READ_PAGE",
  "CLICK_ELEMENT",
  "FILL_FIELD",
  "SELECT_OPTION",
  "PRESS_KEY",
  "SCROLL_PAGE",
  "WAIT_FOR_ELEMENT",
  "NAVIGATE_BACK",
  "ASK_APPROVAL",
  "SEND_MESSAGE",
  "WAIT",
  "STOP_TASK"
]);

export const riskLevelSchema = z.enum([
  "read_only",
  "draft_write",
  "external_write",
  "sensitive"
]);

export const targetSchema = z.object({
  selector: z.string().min(1).max(500).optional(),
  role: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(300).optional(),
  text: z.string().min(1).max(300).optional()
}).refine(
  (target) => Boolean(target.selector || target.role || target.name || target.text),
  "At least one target strategy is required"
);

export const browserActionSchema = z.object({
  id: z.string().uuid(),
  type: actionTypeSchema,
  label: z.string().min(1).max(180),
  risk: riskLevelSchema,
  requiresApproval: z.boolean(),
  target: targetSchema.optional(),
  value: z.string().max(10_000).optional(),
  url: z.string().url().optional(),
  delayMs: z.number().int().min(0).max(60_000).optional(),
  status: z.enum(["pending", "running", "completed", "failed", "blocked"]).default("pending")
}).superRefine((action, context) => {
  if (action.type === "OPEN_URL" && !action.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OPEN_URL requires url" });
  }
  if (["CLICK_ELEMENT", "FILL_FIELD", "SELECT_OPTION", "WAIT_FOR_ELEMENT", "SEND_MESSAGE"].includes(action.type) && !action.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${action.type} requires target` });
  }
  if (["FILL_FIELD", "SELECT_OPTION", "PRESS_KEY", "SCROLL_PAGE", "SEND_MESSAGE"].includes(action.type) && action.value === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${action.type} requires value` });
  }
  if (action.type === "SEND_MESSAGE" && !action.requiresApproval) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "SEND_MESSAGE must require approval" });
  }
});

export const createMissionSchema = z.object({
  goal: z.string().min(3).max(4_000),
  deviceId: z.string().min(3).max(160),
  context: z.object({
    activeUrl: z.string().url().optional(),
    eventId: z.string().max(160).optional(),
    clubId: z.string().max(160).optional(),
    accountId: z.string().max(160).optional()
  }).default({})
});

export const missionSchema = z.object({
  id: z.string().uuid(),
  goal: z.string(),
  deviceId: z.string(),
  status: z.enum(["planned", "running", "awaiting_approval", "completed", "failed", "cancelled"]),
  actions: z.array(browserActionSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const approvalSchema = z.object({
  missionId: z.string().uuid(),
  actionIds: z.array(z.string().uuid()).min(1).max(100),
  approved: z.boolean(),
  expiresAt: z.string().datetime(),
  messageHash: z.string().min(16).max(200).optional()
});

export const missionEventSchema = z.object({
  missionId: z.string().uuid(),
  actionId: z.string().uuid().optional(),
  type: z.enum([
    "MISSION_STARTED",
    "ACTION_STARTED",
    "ACTION_COMPLETED",
    "ACTION_FAILED",
    "MISSION_PAUSED",
    "MISSION_COMPLETED",
    "PLATFORM_WARNING"
  ]),
  payload: z.record(z.unknown()).default({}),
  occurredAt: z.string().datetime()
});

export type BrowserAction = z.infer<typeof browserActionSchema>;
export type CreateMissionInput = z.infer<typeof createMissionSchema>;
export type Mission = z.infer<typeof missionSchema>;
export type ApprovalInput = z.infer<typeof approvalSchema>;
export type MissionEvent = z.infer<typeof missionEventSchema>;

export function isWriteAction(action: BrowserAction): boolean {
  return action.risk === "external_write" || action.risk === "sensitive";
}
