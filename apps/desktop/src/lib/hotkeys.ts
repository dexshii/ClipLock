type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);

/** Converts a keyboard event into an accelerator string understood by the global shortcut plugin. */
export function acceleratorFromEvent(e: KeyLike): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  let key = e.code;
  if (key.startsWith('Key')) key = key.slice(3);
  else if (key.startsWith('Digit')) key = key.slice(5);
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  // Require a modifier for ordinary keys so typing in games doesn't trigger ClipLock.
  if (mods.length === 0 && !isFunctionKey) return null;
  return [...mods, key].join('+');
}

