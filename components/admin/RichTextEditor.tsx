import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Bold, Code2, Italic, Type, Underline } from 'lucide-react';

// Message editor for the exam emails: what you type is what the email shows, with Bold / Italic /
// Underline. The value it reads and writes is the email builder's message format (services/
// examEmail.ts): text with line breaks as "\n" (a blank line starts a new paragraph) and the
// formatting as <b>, <i> and <u> tags. Tags are closed at the end of every line, so the builder can
// wrap each paragraph in its own <p> and the markup stays well formed.
//
// A message written by hand with other HTML (a link, a colour) opens in the "HTML" view instead: a
// plain text box that shows it exactly as stored, so nothing is lost by opening it here.

type Fmt = { b: boolean; i: boolean; u: boolean };
type Token = { text: string; fmt: Fmt } | 'nl' | 'block';

const NO_FMT: Fmt = { b: false, i: false, u: false };
const FMT_KEYS = ['b', 'i', 'u'] as const;
const TAG_FMT: Record<string, keyof Fmt> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u' };
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
]);

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The formatting an element gives its text: its tag, then its inline style (which a browser may use
// instead of a tag, and which can also switch bold or italic back off).
const elementFmt = (el: HTMLElement, inherited: Fmt): Fmt => {
  const fmt = { ...inherited };
  const key = TAG_FMT[el.tagName];
  if (key) fmt[key] = true;
  const style = el.style;
  if (style) {
    const weight = style.fontWeight;
    if (weight) {
      const numeric = parseInt(weight, 10);
      fmt.b = weight === 'bold' || weight === 'bolder' || (Number.isFinite(numeric) && numeric >= 600);
    }
    if (style.fontStyle) fmt.i = style.fontStyle === 'italic' || style.fontStyle === 'oblique';
    if (/underline/.test(`${style.textDecorationLine || ''} ${style.textDecoration || ''}`)) fmt.u = true;
  }
  return fmt;
};

const collectTokens = (node: Node, fmt: Fmt, tokens: Token[]) => {
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.nodeValue || '').replace(/\r/g, '').replace(/ /g, ' ');
      text.split('\n').forEach((part, index) => {
        if (index > 0) tokens.push('nl');
        if (part !== '') tokens.push({ text: part, fmt });
      });
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as HTMLElement;
    if (el.tagName === 'BR') {
      tokens.push('nl');
      return;
    }
    const block = BLOCK_TAGS.has(el.tagName);
    if (block) tokens.push('block');
    collectTokens(el, elementFmt(el, fmt), tokens);
    if (block) tokens.push('block');
  });
};

/**
 * A DOM subtree (the editor, or a parsed message) as the stored message text: "\n" line breaks and
 * only <b>/<i>/<u> tags, opened and closed within each line. Trailing line breaks are dropped (a
 * browser keeps one at the end of an editable area as a caret placeholder).
 */
export const serializeRichText = (root: Node): string => {
  const tokens: Token[] = [];
  collectTokens(root, NO_FMT, tokens);
  let out = '';
  let open: (keyof Fmt)[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) out += `</${open.pop()}>`;
  };
  for (const token of tokens) {
    if (token === 'nl') {
      closeTo(0);
      out += '\n';
    } else if (token === 'block') {
      // A block element starts and ends on its own line.
      closeTo(0);
      if (out !== '' && !out.endsWith('\n')) out += '\n';
    } else {
      const wanted = FMT_KEYS.filter(key => token.fmt[key]);
      let common = 0;
      while (common < open.length && common < wanted.length && open[common] === wanted[common]) common++;
      closeTo(common);
      for (const key of wanted.slice(common)) {
        out += `<${key}>`;
        open.push(key);
      }
      out += escapeText(token.text);
    }
  }
  closeTo(0);
  return out.replace(/\n+$/, '');
};

const parseMessage = (value: string): DocumentFragment => {
  // A <template> parses without running scripts or loading images.
  const template = document.createElement('template');
  template.innerHTML = value;
  return template.content;
};

/** True when a message uses HTML beyond bold / italic / underline, which the formatted view cannot show. */
export const richTextHasUnsupportedMarkup = (value: string): boolean => {
  if (!/[<]/.test(value)) return false;
  const walker = document.createTreeWalker(parseMessage(value), NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const el = node as Element;
    if (el.tagName !== 'BR' && !TAG_FMT[el.tagName]) return true;
    if (el.attributes.length > 0) return true;
  }
  return false;
};

/** The stored message as the editable area's HTML (it shows "\n" as line breaks: white-space pre-wrap). */
const toEditorHtml = (value: string): string => serializeRichText(parseMessage(value));

export interface RichTextEditorHandle {
  /** Insert plain text (e.g. a placeholder) where the caret is, or last was. */
  insertText: (text: string) => void;
  focus: () => void;
}

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Longest message accepted, counted on the stored text (tags included). */
  maxLength?: number;
  /** Lines visible before the box starts scrolling (it also grows up to a limit). */
  rows?: number;
  onFocus?: () => void;
  className?: string;
}

type Mode = 'rich' | 'source';

const ToolbarButton: React.FC<{
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, shortcut, pressed, disabled, onClick, children }) => (
  <button
    type="button"
    title={shortcut ? `${label} (${shortcut})` : label}
    aria-label={label}
    aria-pressed={pressed}
    disabled={disabled}
    // Keep the selection (and the caret) in the text while the button is clicked.
    onMouseDown={e => e.preventDefault()}
    onClick={onClick}
    className={`inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      pressed ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-200'
    }`}
  >
    {children}
  </button>
);

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(({
  value, onChange, id, ariaLabel, ariaLabelledBy, maxLength, rows = 7, onFocus, className = '',
}, ref) => {
  const [mode, setMode] = useState<Mode>(() => (richTextHasUnsupportedMarkup(value) ? 'source' : 'rich'));
  const [active, setActive] = useState<Fmt>(NO_FMT);
  const editorRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  // The value this editor last produced (or last loaded). A `value` prop equal to it is our own edit
  // coming back, so the editable area is left alone and the caret stays where it is.
  const lastValue = useRef<string | null>(null);
  // The admin chose the HTML view: stay there even for a message the formatted view could show.
  const sourcePinned = useRef(false);
  const savedRange = useRef<Range | null>(null);

  const unsupported = mode === 'source' && richTextHasUnsupportedMarkup(value);

  useLayoutEffect(() => {
    if (value === lastValue.current) return;
    // A value from outside: first load, another template, a reset, a placeholder added by the parent.
    const wanted: Mode = sourcePinned.current || richTextHasUnsupportedMarkup(value) ? 'source' : 'rich';
    if (wanted !== mode) {
      setMode(wanted); // runs this effect again, in the right view
      return;
    }
    if (mode === 'rich' && editorRef.current) editorRef.current.innerHTML = toEditorHtml(value);
    lastValue.current = value;
    savedRange.current = null;
  }, [value, mode]);

  const selectionInside = (): Selection | null => {
    const el = editorRef.current;
    const selection = document.getSelection();
    return el && selection && selection.rangeCount > 0 && el.contains(selection.anchorNode) ? selection : null;
  };

  const refreshActive = useCallback(() => {
    const selection = selectionInside();
    if (!selection) return;
    savedRange.current = selection.getRangeAt(0).cloneRange();
    try {
      const next: Fmt = {
        b: document.queryCommandState('bold'),
        i: document.queryCommandState('italic'),
        u: document.queryCommandState('underline'),
      };
      setActive(prev => (prev.b === next.b && prev.i === next.i && prev.u === next.u ? prev : next));
    } catch {
      // queryCommandState is unavailable: the buttons still work, they just don't light up.
    }
  }, []);

  useEffect(() => {
    document.addEventListener('selectionchange', refreshActive);
    return () => document.removeEventListener('selectionchange', refreshActive);
  }, [refreshActive]);

  // Put the caret back in the text (where it last was, else at the end) before a toolbar action.
  const ensureSelection = () => {
    const el = editorRef.current;
    if (!el || selectionInside()) return;
    el.focus();
    const selection = document.getSelection();
    if (!selection) return;
    let range = savedRange.current;
    if (!range || !el.contains(range.startContainer) || !el.contains(range.endContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const emit = () => {
    const el = editorRef.current;
    if (!el) return;
    const next = serializeRichText(el);
    if (maxLength && next.length > maxLength) {
      // Over the limit: put back the last accepted text rather than save a message cut mid-word.
      el.innerHTML = toEditorHtml(lastValue.current ?? '');
      const selection = document.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }
    if (next === lastValue.current) return;
    lastValue.current = next;
    onChange(next);
  };

  // Plain text in, one execCommand per line: the browser keeps its undo history, and a line break is
  // always a line break (never a new <div>, which browsers disagree on).
  const insertPlain = (text: string) => {
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
      if (index > 0) document.execCommand('insertLineBreak');
      if (line !== '') document.execCommand('insertText', false, line);
    });
  };

  const format = (command: 'bold' | 'italic' | 'underline') => {
    if (mode !== 'rich') return;
    ensureSelection();
    try {
      document.execCommand('styleWithCSS', false, 'false');
    } catch {
      // not supported everywhere; tags are the default anyway
    }
    document.execCommand(command);
    emit();
    refreshActive();
  };

  const changeSource = (next: string) => {
    lastValue.current = next;
    onChange(next);
  };

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      if (mode === 'source') {
        const el = sourceRef.current;
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? value.length;
        changeSource(value.slice(0, start) + text + value.slice(end));
        requestAnimationFrame(() => {
          const target = sourceRef.current;
          if (!target) return;
          target.focus();
          target.setSelectionRange(start + text.length, start + text.length);
        });
        return;
      }
      ensureSelection();
      insertPlain(text);
      emit();
    },
    focus: () => (mode === 'source' ? sourceRef.current : editorRef.current)?.focus(),
  }), [mode, value]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    sourcePinned.current = next === 'source';
    // Forget what was loaded so the formatted view is filled from the current text when it opens.
    if (next === 'rich') lastValue.current = null;
    setMode(next);
  };

  const lineHeight = 22;
  const minHeight = rows * lineHeight + 16;

  return (
    <div className={`rounded-lg border border-slate-200 bg-white focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-100 ${className}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 bg-slate-50 px-1.5 py-1 rounded-t-lg" role="toolbar" aria-label="Text formatting">
        <ToolbarButton label="Bold" shortcut="Ctrl+B" pressed={mode === 'rich' && active.b} disabled={mode !== 'rich'} onClick={() => format('bold')}>
          <Bold size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Italic" shortcut="Ctrl+I" pressed={mode === 'rich' && active.i} disabled={mode !== 'rich'} onClick={() => format('italic')}>
          <Italic size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Underline" shortcut="Ctrl+U" pressed={mode === 'rich' && active.u} disabled={mode !== 'rich'} onClick={() => format('underline')}>
          <Underline size={14} aria-hidden="true" />
        </ToolbarButton>
        <span className="ml-auto" />
        {mode === 'rich' ? (
          <ToolbarButton label="Edit as HTML" onClick={() => switchMode('source')}>
            <Code2 size={14} aria-hidden="true" /> <span className="font-medium">HTML</span>
          </ToolbarButton>
        ) : (
          <ToolbarButton label="Back to the formatted view" disabled={unsupported} onClick={() => switchMode('rich')}>
            <Type size={14} aria-hidden="true" /> <span className="font-medium">Formatted view</span>
          </ToolbarButton>
        )}
      </div>

      {mode === 'rich' ? (
        <div
          id={id}
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          contentEditable
          suppressContentEditableWarning
          spellCheck
          className="px-3 py-2 text-sm text-slate-800 outline-none overflow-y-auto break-words rounded-b-lg"
          style={{ minHeight, maxHeight: 420, lineHeight: `${lineHeight}px`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          onInput={emit}
          onFocus={() => { onFocus?.(); refreshActive(); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              document.execCommand('insertLineBreak');
              emit();
            }
          }}
          onPaste={e => {
            // Text only: formatting copied from Word or a web page does not belong in the email.
            e.preventDefault();
            insertPlain(e.clipboardData.getData('text/plain'));
            emit();
          }}
          onDrop={e => e.preventDefault()}
        />
      ) : (
        <>
          <textarea
            id={id}
            ref={sourceRef}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            rows={rows}
            maxLength={maxLength}
            spellCheck={false}
            className="block w-full px-3 py-2 text-sm font-mono leading-relaxed text-slate-800 outline-none bg-transparent rounded-b-lg resize-y"
            value={value}
            onFocus={onFocus}
            onChange={e => changeSource(e.target.value)}
          />
          <p className="px-3 pb-2 text-[11px] text-slate-500">
            {unsupported
              ? 'This message contains custom HTML, so it is shown as code here. The preview shows how it looks.'
              : 'HTML view: <b>bold</b>, <i>italic</i> and <u>underline</u> are shown as tags.'}
          </p>
        </>
      )}
    </div>
  );
});

RichTextEditor.displayName = 'RichTextEditor';
