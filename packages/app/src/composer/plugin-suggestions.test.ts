import { describe, expect, it, vi } from "vitest";
import {
  acceptComposerSuggestion,
  checkComposerSuggestion,
  ComposerSuggestion,
  isSuggestionAcceptKey,
  createPluginComposer,
  PluginComposerRegistry,
} from "./plugin-suggestions";

function setup() {
  const registry = new PluginComposerRegistry();
  const lifetime = new AbortController();
  return { registry, lifetime, composer: createPluginComposer(lifetime.signal, registry) };
}
const request = { serverId: "host-a", agentId: "agent", text: "Suggested prompt" };

describe("plugin composer suggestion targeting", () => {
  const offered = { status: "suggested" as const, remove: () => {} };

  it("delivers once only to the exact host and agent in the calling app", async () => {
    const { registry, composer, lifetime } = setup();
    const otherClient = setup();
    const calls: Array<{ text: string; signal: AbortSignal }> = [];
    let wrongCalls = 0;
    const wrong = () => {
      wrongCalls++;
      return offered;
    };
    registry.register({
      ...request,
      suggestText: (text, signal) => {
        calls.push({ text, signal });
        return offered;
      },
    });
    registry.register({ serverId: "host-b", agentId: "agent", suggestText: wrong });
    registry.register({ serverId: "host-a", agentId: "other", suggestText: wrong });
    otherClient.registry.register({ ...request, suggestText: wrong });
    expect(await composer.suggestText(request)).toBe(offered);
    expect(calls).toEqual([{ text: request.text, signal: lifetime.signal }]);
    expect(wrongCalls).toBe(0);
  });

  it("refuses unavailable and ambiguous composers without displaying a suggestion", async () => {
    const { registry, composer } = setup();
    expect(await composer.suggestText(request)).toEqual({ status: "composer-unavailable" });
    let calls = 0;
    const suggestText = () => {
      calls++;
      return offered;
    };
    registry.register({ ...request, suggestText });
    registry.register({ ...request, suggestText });
    expect(await composer.suggestText(request)).toEqual({ status: "composer-unavailable" });
    expect(calls).toBe(0);
  });

  it.each(["host-b", "host-a"])(
    "refuses navigation before delivery, including remount on %s",
    async (serverId) => {
      const { registry, composer } = setup();
      const suggestText = () => offered;
      const remove = registry.register({ ...request, suggestText });
      const pending = composer.suggestText(request);
      remove();
      registry.register({ serverId, agentId: request.agentId, suggestText });
      expect(await pending).toEqual({ status: "composer-unavailable" });
    },
  );

  it("checks the draft at delivery and returns the live refusal", async () => {
    const { registry, composer } = setup();
    let refusal: "draft-not-empty" | "submission-in-progress" = "draft-not-empty";
    registry.register({ ...request, suggestText: () => ({ status: refusal }) });
    const pending = composer.suggestText(request);
    expect(await pending).toEqual({ status: "draft-not-empty" });
    const submitting = composer.suggestText(request);
    refusal = "submission-in-progress";
    expect(await submitting).toEqual({ status: "submission-in-progress" });
  });

  it("refuses retained handles after plugin unload and rejects invalid input", async () => {
    const { registry, lifetime, composer } = setup();
    let calls = 0;
    registry.register({
      ...request,
      suggestText: () => {
        calls++;
        return offered;
      },
    });
    const pending = composer.suggestText(request);
    lifetime.abort();
    expect(await pending).toEqual({ status: "composer-unavailable" });
    await expect(composer.suggestText({ ...request, text: "" })).rejects.toThrow(TypeError);
    expect(calls).toBe(0);
  });
});

describe("composer suggestion acceptance guard", () => {
  function composerState() {
    let text = "";
    const replaceText = vi.fn((next: string) => {
      text = next;
    });
    const insertDraftText = vi.fn(() => true);
    return {
      editor: { getText: () => text, replaceText },
      insertDraftText,
      isSubmitting: false,
      hasAttachments: false,
      text: request.text,
    };
  }

  it("inserts through the draft owner and live editor with the caret at the end", () => {
    const state = composerState();
    expect(acceptComposerSuggestion(state)).toEqual({ status: "inserted" });
    expect(state.insertDraftText).toHaveBeenCalledExactlyOnceWith(request.text);
    expect(state.editor.replaceText).toHaveBeenCalledExactlyOnceWith(request.text, {
      start: request.text.length,
      end: request.text.length,
    });
    expect(state.editor.getText()).toBe(request.text);
    expect(acceptComposerSuggestion(state)).toEqual({ status: "draft-not-empty" });
    expect(state.insertDraftText).toHaveBeenCalledTimes(1);
  });

  it.each(["User text", " "])("protects live text %j before draft publication", (text) => {
    const state = composerState();
    state.editor.replaceText(text);
    state.editor.replaceText.mockClear();
    expect(acceptComposerSuggestion(state)).toEqual({ status: "draft-not-empty" });
    expect(state.insertDraftText).not.toHaveBeenCalled();
    expect(state.editor.replaceText).not.toHaveBeenCalled();
  });

  it("protects attachments and in-flight submissions in an empty editor", () => {
    const state = composerState();
    state.hasAttachments = true;
    expect(acceptComposerSuggestion(state)).toEqual({ status: "draft-not-empty" });
    state.isSubmitting = true;
    expect(acceptComposerSuggestion(state)).toEqual({ status: "submission-in-progress" });
    expect(state.insertDraftText).not.toHaveBeenCalled();
    expect(state.editor.replaceText).not.toHaveBeenCalled();
  });

  it("does not change the editor when the draft owner refuses insertion", () => {
    const state = composerState();
    state.insertDraftText.mockReturnValue(false);
    expect(acceptComposerSuggestion(state)).toEqual({ status: "draft-not-empty" });
    expect(state.editor.replaceText).not.toHaveBeenCalled();
    expect(acceptComposerSuggestion({ ...state, editor: null })).toEqual({
      status: "composer-unavailable",
    });
  });

  it("rechecks live text and submission state after async delivery", async () => {
    const { registry, composer } = setup();
    const state = composerState();
    registry.register({
      ...request,
      suggestText: (text, signal) =>
        new ComposerSuggestion(
          () => checkComposerSuggestion(state),
          (accepted) => acceptComposerSuggestion({ ...state, text: accepted }),
        ).show(text, signal),
    });
    const pending = composer.suggestText(request);
    state.editor.replaceText("User typed while pending");
    state.editor.replaceText.mockClear();
    expect(await pending).toEqual({ status: "draft-not-empty" });
    expect(state.insertDraftText).not.toHaveBeenCalled();
    expect(state.editor.getText()).toBe("User typed while pending");
    state.editor.replaceText("");
    const submitting = composer.suggestText(request);
    state.isSubmitting = true;
    expect(await submitting).toEqual({ status: "submission-in-progress" });
    expect(state.insertDraftText).not.toHaveBeenCalled();
  });
});

describe("plugin composer ghost suggestions", () => {
  function suggestionState() {
    let draft = "";
    let attachments = false;
    let submitting = false;
    let writes = 0;
    const check = () => {
      if (submitting) return "submission-in-progress" as const;
      if (draft.length || attachments) return "draft-not-empty" as const;
      return null;
    };
    const suggestion = new ComposerSuggestion(check, (text) => {
      const status = check();
      if (status) return { status };
      draft = text;
      writes++;
      return { status: "inserted" };
    });
    const lifetime = new AbortController();
    return {
      suggestion,
      lifetime,
      get draft() {
        return draft;
      },
      get writes() {
        return writes;
      },
      type(text: string) {
        draft = text;
        suggestion.dismiss();
      },
      attach() {
        attachments = true;
      },
      submit() {
        submitting = true;
      },
    };
  }

  it("shows transient text without writing a draft, then accepts once", () => {
    const state = suggestionState();
    expect(state.suggestion.show(request.text, state.lifetime.signal).status).toBe("suggested");
    expect(state.suggestion.getSnapshot()).toBe(request.text);
    expect(state.draft).toBe("");
    expect(state.writes).toBe(0);
    expect(state.suggestion.accept()).toEqual({ status: "inserted" });
    expect(state.draft).toBe(request.text);
    expect(state.suggestion.getSnapshot()).toBeNull();
    expect(state.suggestion.accept()).toBeNull();
    expect(state.writes).toBe(1);
  });

  it("dismisses on typing and protects attachments/submission added before acceptance", () => {
    const typed = suggestionState();
    typed.suggestion.show(request.text, typed.lifetime.signal);
    typed.type(" ");
    expect(typed.suggestion.accept()).toBeNull();
    expect(typed.draft).toBe(" ");
    for (const change of ["attach", "submit"] as const) {
      const state = suggestionState();
      state.suggestion.show(request.text, state.lifetime.signal);
      state[change]();
      expect(state.suggestion.accept()).toEqual({
        status: change === "attach" ? "draft-not-empty" : "submission-in-progress",
      });
      expect(state.draft).toBe("");
      expect(state.writes).toBe(0);
    }
  });

  it("refuses to offer suggestions over attachment-only drafts or active submission", () => {
    for (const change of ["attach", "submit"] as const) {
      const state = suggestionState();
      state[change]();
      expect(state.suggestion.show(request.text, state.lifetime.signal)).toEqual({
        status: change === "attach" ? "draft-not-empty" : "submission-in-progress",
      });
      expect(state.suggestion.getSnapshot()).toBeNull();
      expect(state.writes).toBe(0);
    }
  });

  it("dismisses on removal, plugin unload, and composer teardown without reviving old suggestions", () => {
    const state = suggestionState();
    const first = state.suggestion.show("First", state.lifetime.signal);
    const secondLifetime = new AbortController();
    state.suggestion.show("Second", secondLifetime.signal);
    if (first.status !== "suggested") throw new Error("Expected suggestion");
    first.remove();
    state.lifetime.abort();
    expect(state.suggestion.getSnapshot()).toBe("Second");
    secondLifetime.abort();
    expect(state.suggestion.getSnapshot()).toBeNull();
    expect(state.writes).toBe(0);
    state.suggestion.show("Unmounted", new AbortController().signal);
    state.suggestion.dismiss();
    expect(state.suggestion.accept()).toBeNull();
  });

  it("binds asynchronously delivered suggestions to the exact host, agent and mount", async () => {
    const { registry, composer, lifetime } = setup();
    const state = suggestionState();
    const registration = {
      ...request,
      suggestText: (text: string, signal: AbortSignal) => state.suggestion.show(text, signal),
    };
    const remove = registry.register(registration);
    const suggest = composer.suggestText;
    expect(await suggest({ ...request, serverId: "host-b" })).toEqual({
      status: "composer-unavailable",
    });
    expect(await suggest({ ...request, agentId: "other" })).toEqual({
      status: "composer-unavailable",
    });
    const pending = suggest(request);
    remove();
    registry.register({ ...registration });
    expect(await pending).toEqual({ status: "composer-unavailable" });
    const changing = suggest(request);
    state.type("Typed while request was pending");
    expect(await changing).toEqual({ status: "draft-not-empty" });
    lifetime.abort();
    expect(await suggest(request)).toEqual({ status: "composer-unavailable" });
    expect(state.writes).toBe(0);
  });

  it("accepts only unmodified Tab or Right Arrow, leaving Enter and navigation keys alone", () => {
    for (const key of ["Tab", "ArrowRight"]) {
      expect(isSuggestionAcceptKey({ key })).toBe(true);
      for (const modifier of ["shiftKey", "metaKey", "ctrlKey", "altKey"]) {
        expect(isSuggestionAcceptKey({ key, [modifier]: true })).toBe(false);
      }
    }
    for (const key of ["Enter", "Escape", "ArrowLeft", "a"])
      expect(isSuggestionAcceptKey({ key })).toBe(false);
  });
});
