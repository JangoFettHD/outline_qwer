import Router from "koa-router";
import { z } from "zod";
import { InvalidRequestError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { buildBitrix24Url } from "../parser";
import { Bitrix24Error, callRestOrThrow } from "../rest";

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
    // groupId "0" is not a real workgroup — treat as absent.
    const normalizedGroupId =
      groupId !== undefined && Number(groupId) > 0 ? String(groupId) : undefined;
    if (normalizedGroupId) {
      params["fields[GROUP_ID]"] = normalizedGroupId;
    }
    if (deadline) {
      params["fields[DEADLINE]"] = deadline;
    }

    let result: CreatedTaskResponse;
    try {
      result = await callRestOrThrow<CreatedTaskResponse>(
        user,
        "tasks.task.add",
        params
      );
    } catch (err) {
      if (err instanceof Bitrix24Error) {
        // Surface the real Bitrix24 reason (ACCESS_DENIED, bad DEADLINE, or a
        // reauth prompt) instead of a generic failure.
        throw InvalidRequestError(
          err.reauthRequired
            ? "Your Bitrix24 session has expired — please sign in with Bitrix24 again."
            : `Bitrix24: ${err.description || err.code}`
        );
      }
      throw err;
    }
    if (!result?.task?.id) {
      throw InvalidRequestError(
        "Bitrix24 task creation failed — no task id returned."
      );
    }

    const id = String(result.task.id);
    const url = buildBitrix24Url({
      type: "task",
      id,
      groupId: normalizedGroupId,
    });

    ctx.body = { data: { id, url } };
  }
);

export default router;
