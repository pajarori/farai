import type { TextareaRenderable } from "@opentui/core";
import { createContext, createSignal, useContext, type Accessor, type JSX } from "solid-js";

export type PendingPaste = {
  label: string;
  text: string;
  chars: number;
};

export type ComposerControl = {
  ref: Accessor<TextareaRenderable | undefined>;
  setRef(ref: TextareaRenderable | undefined): void;
  text: Accessor<string>;
  setText(text: string): void;
  setDraft(text: string): void;
  pendingPastes: Accessor<readonly PendingPaste[]>;
  insertText(text: string): void;
  addLargePaste(text: string): string;
  expandedText(): string;
  clearPendingPastes(): void;
  focus(): void;
  blur(): void;
  clear(): void;
  newline(): void;
};

const ComposerContext = createContext<ComposerControl>();

type ComposerProviderProps = {
  children: JSX.Element;
};

export function ComposerProvider(props: ComposerProviderProps): JSX.Element {
  const [ref, setRefSignal] = createSignal<TextareaRenderable>();
  const [text, setText] = createSignal("");
  const [pendingPastes, setPendingPastes] = createSignal<PendingPaste[]>([]);

  const control: ComposerControl = {
    ref,
    setRef(next) { setRefSignal(() => next); },
    text,
    setText,
    setDraft(next: string) {
      try { ref()?.setText(next); } catch {  }
      setText(next);
    },
    pendingPastes,
    insertText(value: string) {
      try {
        ref()?.insertText(value);
        setText(ref()?.plainText ?? text());
      } catch {
        const next = `${text()}${value}`;
        try { ref()?.setText(next); } catch {  }
        setText(next);
      }
    },
    addLargePaste(value: string): string {
      const chars = [...value].length;
      const base = `[pasted content ${chars} chars]`;
      const draft = ref()?.plainText ?? text();
      const existing = pendingPastes().filter((paste) => paste.chars === chars && draft.includes(paste.label));
      const label = existing.length === 0 ? base : `[pasted content ${chars} chars #${existing.length + 1}]`;
      setPendingPastes((items) => [...items.filter((paste) => draft.includes(paste.label)), { label, text: value, chars }]);
      return label;
    },
    expandedText(): string {
      let value = ref()?.plainText ?? text();
      for (const paste of pendingPastes()) {
        value = value.split(paste.label).join(paste.text);
      }
      return value;
    },
    clearPendingPastes() {
      setPendingPastes([]);
    },
    focus() { try { ref()?.focus(); } catch {  } },
    blur() { try { ref()?.blur(); } catch {  } },
    clear() {
      try { ref()?.setText(""); } catch {  }
      setText("");
      setPendingPastes([]);
    },
    newline() {
      try { ref()?.newLine(); setText(ref()?.plainText ?? text()); } catch {  }
    }
  };

  return <ComposerContext.Provider value={control}>{props.children}</ComposerContext.Provider>;
}

export function useComposerControl(): ComposerControl {
  const ctx = useContext(ComposerContext);
  if (!ctx) throw new Error("ComposerProvider missing");
  return ctx;
}
