import { describe, expect, it } from 'vitest';
import { acceleratorFromEvent } from './hotkeys';

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('acceleratorFromEvent', () => {
  it('builds accelerators the global shortcut plugin understands', () => {
    expect(acceleratorFromEvent(key('F10', { altKey: true }))).toBe('Alt+F10');
    expect(acceleratorFromEvent(key('KeyK', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+K');
    expect(acceleratorFromEvent(key('Digit5', { altKey: true }))).toBe('Alt+5');
  });
  it('allows bare function keys but not bare letters', () => {
    expect(acceleratorFromEvent(key('F9'))).toBe('F9');
    expect(acceleratorFromEvent(key('KeyW'))).toBeNull();
  });
  it('ignores lone modifiers', () => {
    expect(acceleratorFromEvent(key('AltLeft', { altKey: true }))).toBeNull();
  });
});
