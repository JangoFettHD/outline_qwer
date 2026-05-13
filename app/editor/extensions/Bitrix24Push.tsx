import i18next from "i18next";
import { toast } from "sonner";
import type { Node as ProsemirrorNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import Extension from "@shared/editor/lib/Extension";
import { client } from "~/utils/ApiClient";

/**
 * Translate via the globally-initialised i18next instance. Outline boots
 * i18next once at app start, so by the time editor commands fire it is
 * ready. Wrapper exists so toasts in this file stay one short call.
 */
const t = (key: string, opts?: Record<string, string | number>): string =>
  opts ? (i18next.t(key, opts) as string) : (i18next.t(key) as string);

/**
 * Push-side Bitrix24 commands: create one or many `tasks.task.add` entries
 * straight from the editor.
 *
 *   `bitrix24CreateTaskFromSelection`
 *     Takes the currently selected text, uses the first line as the task
 *     title and the rest as the description, calls `/api/bitrix24.createTask`,
 *     and replaces the selection with the new task's URL. The URL is
 *     resolved to an inline card by the Bitrix24 EmbedDescriptor.
 *
 *   `bitrix24ConvertChecklist`
 *     Finds the nearest `checkbox_list` around the caret and creates one
 *     Bitrix24 task per item, using the item's text as the title. Each
 *     item's text is then replaced with a link to its new task.
 *
 * Both commands degrade gracefully: any REST failure surfaces as a toast
 * and the document is left untouched. The caller must have signed in via
 * Bitrix24 OAuth at least once so a valid token sits in their
 * `UserAuthentication` record — otherwise the server returns 204 and we
 * surface a "could not create task" toast.
 */
export default class Bitrix24PushExtension extends Extension {
  get name() {
    return "bitrix24-push";
  }

  commands() {
    return {
      bitrix24CreateTaskFromSelection: () => createFromSelection,
      bitrix24ConvertChecklist: () => convertChecklist,
    };
  }
}

/**
 * Editor command: turn the current selection into a Bitrix24 task. Runs the
 * REST call + insertion off the dispatch path so ProseMirror's transaction
 * pipeline stays purely synchronous.
 *
 * @returns `true` if the selection is non-empty (command is "available");
 *   `false` otherwise. The async work always runs when dispatch is provided.
 */
function createFromSelection(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView
): boolean {
  if (!view) {
    return false;
  }
  const { from, to } = state.selection;
  const selected = state.doc.textBetween(from, to, "\n").trim();

  if (!selected) {
    toast.message(t("Select some text first — it will become the task title."));
    return false;
  }

  if (dispatch) {
    void runCreateTask(view, from, to, selected);
  }
  return true;
}

/**
 * Editor command: walk the enclosing `checkbox_list` and create one Bitrix24
 * task per item. Collects items synchronously, then runs the REST fan-out
 * + per-item replacement asynchronously.
 *
 * @returns `true` if a non-empty checklist is found around the caret.
 */
function convertChecklist(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView
): boolean {
  if (!view) {
    return false;
  }
  const list = findEnclosingChecklist(state);
  if (!list) {
    toast.message(t("Place the cursor inside a checklist to convert its items."));
    return false;
  }

  // Items: { from, to, text } in DOCUMENT order. We replace bottom-up so
  // earlier replacements don't invalidate later positions.
  const items: Array<{ from: number; to: number; text: string }> = [];
  list.node.descendants((child, offset) => {
    if (child.type.name === "checkbox_item") {
      const text = child.textContent.trim();
      if (text) {
        const innerFrom = list.pos + offset + 1; // +1 for the wrapper node
        items.push({
          from: innerFrom,
          to: innerFrom + child.content.size,
          text,
        });
      }
      return false; // do not recurse into nested checkboxes
    }
    return true;
  });

  if (items.length === 0) {
    toast.message(t("This checklist is empty — nothing to convert."));
    return false;
  }

  if (dispatch) {
    void runConvertChecklist(view, items);
  }
  return true;
}

/**
 * Locate the nearest ancestor `checkbox_list` containing the caret.
 *
 * @param state editor state to inspect.
 * @returns `{ node, pos }` of the list, or `null` if not inside one.
 */
function findEnclosingChecklist(
  state: EditorState
): { node: ProsemirrorNode; pos: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "checkbox_list") {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
}

interface CreateTaskResponse {
  data: { id: string; url: string };
}

/**
 * Single-selection roundtrip: POST title/description, replace the selection
 * with the resulting task URL (linked, so the embed system picks it up).
 */
async function runCreateTask(
  view: EditorView,
  from: number,
  to: number,
  text: string
): Promise<void> {
  const lines = text.split("\n");
  const title = lines[0].slice(0, 250);
  const description = lines.slice(1).join("\n").trim() || undefined;

  let res: CreateTaskResponse;
  try {
    res = (await client.post("/bitrix24.createTask", {
      title,
      description,
    })) as CreateTaskResponse;
  } catch (err) {
    toast.error(t("Could not create Bitrix24 task"));
    // oxlint-disable-next-line no-console
    console.warn("bitrix24.createTask failed", err);
    return;
  }

  const { state, dispatch } = view;
  const url = res.data.url;
  const linkMark = state.schema.marks.link;
  const tr = state.tr.replaceWith(from, to, state.schema.text(url));
  if (linkMark) {
    tr.addMark(from, from + url.length, linkMark.create({ href: url }));
  }
  dispatch(tr);

  toast.success(t("Bitrix24 task created"));
}

/**
 * Bulk roundtrip: one POST per checklist item, sequential to keep order
 * and avoid hammering Bitrix24's per-method rate limit.
 */
async function runConvertChecklist(
  view: EditorView,
  items: Array<{ from: number; to: number; text: string }>
): Promise<void> {
  let created = 0;
  let failed = 0;

  // Replace bottom-up so earlier positions stay valid as we mutate the doc.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    try {
      const res = (await client.post("/bitrix24.createTask", {
        title: item.text.slice(0, 250),
      })) as CreateTaskResponse;
      const url = res.data.url;
      const { state, dispatch } = view;
      const linkMark = state.schema.marks.link;
      const tr = state.tr.replaceWith(
        item.from,
        item.to,
        state.schema.text(url)
      );
      if (linkMark) {
        tr.addMark(
          item.from,
          item.from + url.length,
          linkMark.create({ href: url })
        );
      }
      dispatch(tr);
      created += 1;
    } catch (err) {
      failed += 1;
      // oxlint-disable-next-line no-console
      console.warn("bitrix24.createTask failed for checklist item", err);
    }
  }

  if (failed === 0) {
    toast.success(t("Created {{ count }} Bitrix24 tasks", { count: created }));
  } else {
    toast.error(t("Created {{ created }} tasks, {{ failed }} failed.", { created, failed }));
  }
}
