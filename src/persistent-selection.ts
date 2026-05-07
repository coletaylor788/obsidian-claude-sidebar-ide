// CodeMirror extension that keeps the editor selection visible after focus
// moves away (e.g., when the user clicks into a Claude tab to type with the
// highlighted text already sent to the agent).
//
// Why this exists: CodeMirror 6's drawSelection extension removes the
// .cm-selectionBackground overlay divs from the DOM on blur, so a CSS rule
// alone cannot keep the highlight visible. We add a Decoration ourselves
// that paints a muted background on the selection range — decorations
// render regardless of focus state, and we toggle ours on only when the
// editor is blurred so we don't double-paint over CM's own overlay.

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const CSS_CLASS = "vault-terminal-persistent-selection";

function buildDecorations(view: EditorView): DecorationSet {
  if (view.hasFocus) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    builder.add(range.from, range.to, Decoration.mark({ class: CSS_CLASS }));
  }
  return builder.finish();
}

export const persistentSelectionExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (
        update.focusChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.docChanged
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
