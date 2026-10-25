import type { MessageInputRef } from "./input/input";
import type {
  PluginComposer,
  PluginComposerSuggestionInput,
  PluginComposerSuggestionResult,
} from "@getpaseo/plugin/client";

type ComposerRefusal = Exclude<PluginComposerSuggestionResult["status"], "suggested">;
interface ComposerAcceptanceResult {
  status: "inserted" | ComposerRefusal;
}

interface ComposerAcceptanceInput {
  text: string;
  editor: Pick<MessageInputRef, "getText" | "replaceText"> | null;
  isSubmitting: boolean;
  hasAttachments: boolean;
  insertDraftText(text: string): boolean;
}

export function checkComposerSuggestion(input: ComposerAcceptanceInput): ComposerRefusal | null {
  const { editor } = input;
  if (!editor) return "composer-unavailable";
  if (input.isSubmitting) return "submission-in-progress";
  if (editor.getText().length > 0 || input.hasAttachments) return "draft-not-empty";
  return null;
}

export function acceptComposerSuggestion(input: ComposerAcceptanceInput): ComposerAcceptanceResult {
  const status = checkComposerSuggestion(input);
  if (status) return { status };
  const { editor, text } = input;
  if (!editor) return { status: "composer-unavailable" };
  if (!input.insertDraftText(text)) return { status: "draft-not-empty" };
  // The live buffer must observe the insertion before the result resolves, even
  // when React has not yet delivered the owner's replacement to the editor.
  editor.replaceText(text, { start: text.length, end: text.length });
  return { status: "inserted" };
}

interface ComposerTarget extends Pick<PluginComposerSuggestionInput, "serverId" | "agentId"> {
  suggestText(text: string, signal: AbortSignal): PluginComposerSuggestionResult;
}

/** Transient presentation only; the draft owner is touched exclusively on acceptance. */
export class ComposerSuggestion {
  private current: { text: string; remove(): void } | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private check: () => ReturnType<typeof checkComposerSuggestion>,
    private insert: (text: string) => ComposerAcceptanceResult,
  ) {}

  getSnapshot = (): string | null => this.current?.text ?? null;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  dismiss = (): void => this.current?.remove();

  show(text: string, signal: AbortSignal): PluginComposerSuggestionResult {
    if (signal.aborted) return { status: "composer-unavailable" };
    const status = this.check();
    if (status) return { status };
    this.dismiss();
    const entry = {
      text,
      remove: () => {
        signal.removeEventListener("abort", entry.remove);
        if (this.current !== entry) return;
        this.current = null;
        for (const listener of this.listeners) listener();
      },
    };
    this.current = entry;
    signal.addEventListener("abort", entry.remove, { once: true });
    for (const listener of this.listeners) listener();
    return { status: "suggested", remove: entry.remove };
  }

  accept = (): ComposerAcceptanceResult | null => {
    const text = this.current?.text;
    this.dismiss();
    return text === undefined ? null : this.insert(text);
  };
}

export function isSuggestionAcceptKey(event: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): boolean {
  return (
    (event.key === "Tab" || event.key === "ArrowRight") &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

/** One registry per app JS runtime/window. No daemon event or cross-client broadcast. */
export class PluginComposerRegistry {
  private targets = new Set<ComposerTarget>();

  register(target: ComposerTarget): () => void {
    this.targets.add(target);
    return () => {
      this.targets.delete(target);
    };
  }

  private resolve(input: PluginComposerSuggestionInput): ComposerTarget | undefined {
    const matches = [...this.targets].filter(
      (target) => target.serverId === input.serverId && target.agentId === input.agentId,
    );
    // Never choose arbitrarily between two active editors for the same conversation.
    return matches.length === 1 ? matches[0] : undefined;
  }

  async suggestText(
    input: PluginComposerSuggestionInput,
    signal: AbortSignal,
  ): Promise<PluginComposerSuggestionResult> {
    if (!input.serverId.trim() || !input.agentId.trim() || !input.text.length) {
      throw new TypeError("Composer suggestion requires serverId, agentId, and non-empty text");
    }
    const request = { ...input };
    const target = this.resolve(request);
    // Bind the request to this mount; navigation or remount before delivery refuses it.
    await Promise.resolve();
    if (signal.aborted || !target || this.resolve(request) !== target) {
      return { status: "composer-unavailable" };
    }
    return target.suggestText(request.text, signal);
  }
}

export const pluginComposerRegistry = new PluginComposerRegistry();

export function createPluginComposer(
  signal: AbortSignal,
  registry = pluginComposerRegistry,
): PluginComposer {
  return {
    suggestText: (input) => registry.suggestText(input, signal),
  };
}
