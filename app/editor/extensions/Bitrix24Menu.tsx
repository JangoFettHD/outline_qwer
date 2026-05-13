import { action } from "mobx";
import type { WidgetProps } from "@shared/editor/lib/Extension";
import Suggestion from "~/editor/extensions/Suggestion";
import Bitrix24Menu from "../components/Bitrix24Menu";

/**
 * Editor extension that opens a Bitrix24 entity picker when the user types
 * `:b` followed by a query. The picker hits `/api/bitrix24.search` and on
 * selection inserts the entity's URL — which the server-side unfurl
 * (see plugins/bitrix24/server/unfurl.ts) later resolves to a rich card.
 *
 * Trigger choice: `:b` is short, easy to type, and doesn't collide with the
 * existing triggers `@` (mentions), `:` (emoji), or `/` (block menu —
 * `:` followed by a space inside `:b ` is treated as a normal character by
 * the emoji menu's openRegex because the second character is `b`, not a word
 * char, but we still require a space-or-character after `:b` to avoid
 * accidentally opening on a stray colon).
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
