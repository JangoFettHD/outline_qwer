import Router from "koa-router";
import { z } from "zod";
import { InvalidRequestError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { buildBitrix24Url } from "../parser";
import { callRest } from "../rest";

const router = new Router();

/**
 * Body schema for `POST /api/bitrix24.createTask`.
 *
 * Mandatory: a non-empty `title`. Everything else is optional and forwarded
 * verbatim to `tasks.task.add` — Bitrix24 itself supplies sensible defaults
 * (responsible = current user, group = none, no deadline).
 */
const CreateTaskSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(255),
    description: z.string().max(20000).optional(),
    /** Bitrix24 user id of the responsible person. Default: the API caller. */
    responsibleId: z.union([z.string(), z.number()]).optional(),
    /** Workgroup (project) id to attach the task to. */
    groupId: z.union([z.string(), z.number()]).optional(),
    /** ISO 8601 deadline. Bitrix24 will parse it into its server timezone. */
    deadline: z.string().optional(),
  }),
});
type CreateTaskReq = z.infer<typeof CreateTaskSchema>;

interface CreatedTaskResponse {
  task: { id: string | number };
}

router.post(
  "bitrix24.createTask",
  rateLimiter(RateLimiterStrategy.OneHundredPerHour),
  auth(),
  validate(CreateTaskSchema),
  async (ctx: APIContext<CreateTaskReq>) => {
    const { title, description, responsibleId, groupId, deadline } =
      ctx.input.body;
    const { user } = ctx.state.auth;

    // Bitrix24 expects nested object `fields[KEY]=value`. We pass each known
    // optional through only when present so unspecified ones use the portal
    // defaults (e.g. responsible = caller).
    const params: Record<string, string | number> = {
      "fields[TITLE]": title,
    };
    if (description) {
      params["fields[DESCRIPTION]"] = description;
    }
    if (responsibleId !== undefined) {
      params["fields[RESPONSIBLE_ID]"] = String(responsibleId);
    }
    if (groupId !== undefined) {
      params["fields[GROUP_ID]"] = String(groupId);
    }
    if (deadline) {
      params["fields[DEADLINE]"] = deadline;
    }

    const result = await callRest<CreatedTaskResponse>(
      user,
      "tasks.task.add",
      params
    );
    if (!result?.task?.id) {
      throw InvalidRequestError(
        "Bitrix24 task creation failed — no task id returned."
      );
    }

    const id = String(result.task.id);
    const url = buildBitrix24Url({
      type: "task",
      id,
      groupId: groupId !== undefined ? String(groupId) : undefined,
    });

    ctx.body = { data: { id, url } };
  }
);

export default router;
