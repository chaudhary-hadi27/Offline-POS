'use strict';

function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();

  return {
    get: () => state,
    set(partial) {
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const shellStore = createStore({
  route: 'dashboard', // 'dashboard' | a module id
  paletteOpen: false,
  shortcutSheetOpen: false,
});
