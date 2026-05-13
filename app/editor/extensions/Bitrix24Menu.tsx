import { action } from "mobx";
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
   * Editor command surface. `bitrix24Picker` inserts the trigger text
   * (`:b `) at the caret — used by the slash block menu entry. The
   * Suggestion base class's InputRule then fires on the newly-inserted
   * text and opens the picker exactly as if the user had typed `:b`.
   *
   * This approach (insert trigger text vs. flip `state.open` directly) is
   * what lets users keep typing to refine the query after `/Bitrix24` —
   * each subsequent character is captured by openRegex and pushed through
   * to `Bitrix24Menu` as `props.search`, so the popover updates live.
   */
  commands() {
    return {
      bitrix24Picker:
        () =>
        (
          state: EditorState,
          dispatch?: (tr: Transaction) => void
        ): boolean => {
          if (dispatch) {
            dispatch(state.tr.insertText(":b "));
          }
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
