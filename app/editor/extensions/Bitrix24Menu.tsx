import { action, runInAction } from "mobx";
import type { EditorState, Transaction } from "prosemirror-state";
import type { WidgetProps } from "@shared/editor/lib/Extension";
import Suggestion from "~/editor/extensions/Suggestion";
import Bitrix24Menu from "../components/Bitrix24Menu";

/**
 * Editor extension that opens a Bitrix24 entity picker. There are two ways
 * for the user to invoke it:
 *
 *   1. `:b <query>`  — typing the trigger inline (handled by the Suggestion
 *                      regex base class).
 *   2. `/bitrix24`   — picking the entry from the slash block menu, which
 *                      dispatches the `bitrix24Picker` command registered
 *                      below. The command flips `state.open = true` and the
 *                      widget renders just like the inline trigger.
 *
 * Trigger choice: `:b` is short and doesn't collide with `@` (mentions),
 * `:` (emoji — needs a word char immediately after the colon, so `:b ` is
 * not a valid emoji shortcode), or `/` (block menu).
 */
export default class Bitrix24MenuExtension extends Suggestion {
  get defaultOptions() {
    return {
      trigger: [":b"],
      allowSpaces: true,
      requireSearchTerm: false,
      enabledInCode: false,
    };
  }

  get name() {
    return "bitrix24-menu";
  }

  /**
   * Editor command surface. `bitrix24Picker` opens the entity picker and is
   * wired to the `/Bitrix24` entry in the slash block menu.
   *
   * It inserts the trigger at the caret and then opens the suggestion state
   * directly. Both details matter. ProseMirror input rules only run from
   * `handleTextInput`, which a programmatic dispatch never reaches, so the
   * base class cannot open the menu for us — previously this command just
   * left a literal `:b ` in the document. And the trigger is inserted with
   * no trailing space because `openRegex` anchors the search term to a
   * non-space character, so a space would stop every later keystroke from
   * matching.
   *
   * The trigger stays in the document on purpose: it is what lets the user
   * keep typing to refine the query, and what `handleClearSearch` later
   * strips before the chosen entity is inserted.
   *
   * @param state current editor state, supplied by the extension manager.
   * @param dispatch transaction dispatcher; absent when the command is only
   *   being probed for availability.
   * @returns always true — the picker can open from any text position.
   */
  commands() {
    return {
      bitrix24Picker:
        () =>
        (
          state: EditorState,
          dispatch?: (tr: Transaction) => void
        ): boolean => {
          if (!dispatch) {
            return true;
          }

          const [trigger] = Array.isArray(this.options.trigger)
            ? this.options.trigger
            : [this.options.trigger];
          const triggerPos = state.selection.from;

          // Insert first: the plugin decorates the trigger range in reaction
          // to the state change below, so that range has to exist by then.
          dispatch(state.tr.insertText(trigger));

          runInAction(() => {
            this.state.query = "";
            this.state.trigger = trigger;
            this.state.triggerPos = triggerPos;
            this.state.open = true;
          });

          return true;
        },
    };
  }

  widget = ({ rtl }: WidgetProps) => (
    <Bitrix24Menu
      rtl={rtl}
      trigger={this.options.trigger}
      isActive={this.state.open}
      search={this.state.query}
      onClose={action(() => {
        this.state.open = false;
      })}
    />
  );
}
