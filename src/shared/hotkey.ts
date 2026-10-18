// Hotkeys like "Alt+Q" or "Ctrl+Shift+E". Matched on KeyboardEvent.code so
// Alt-modified characters (macOS ⌥Q = "œ") and keyboard layouts don't matter.

export interface Hotkey {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  code: string;
}

export function parseHotkey(s: string): Hotkey | null {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const hk: Hotkey = { alt: false, ctrl: false, shift: false, meta: false, code: '' };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'alt' || l === 'option') hk.alt = true;
    else if (l === 'ctrl' || l === 'control') hk.ctrl = true;
    else if (l === 'shift') hk.shift = true;
    else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'super') hk.meta = true;
    else if (/^[a-z]$/i.test(p)) hk.code = `Key${p.toUpperCase()}`;
    else if (/^[0-9]$/.test(p)) hk.code = `Digit${p}`;
    else if (/^f([1-9]|1[0-2])$/i.test(p)) hk.code = p.toUpperCase();
    else if (l === 'space') hk.code = 'Space';
    else if (l === '`' || l === 'backquote') hk.code = 'Backquote';
    else return null;
  }
  return hk.code ? hk : null;
}

export function matchHotkey(e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey' | 'code'>, hk: Hotkey | null): boolean {
  return (
    !!hk &&
    e.code === hk.code &&
    e.altKey === hk.alt &&
    e.ctrlKey === hk.ctrl &&
    e.shiftKey === hk.shift &&
    e.metaKey === hk.meta
  );
}

export function hotkeyFromEvent(e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey' | 'code'>): string | null {
  let key = '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(e.code)) key = e.code;
  else if (e.code === 'Space' || e.code === 'Backquote') key = e.code;
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  if (!mods.length && !/^F/.test(key)) return null;
  return [...mods, key].join('+');
}
