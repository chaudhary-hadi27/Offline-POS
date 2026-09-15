'use strict';

import { MODULES } from './modules.js';
import { iconMarkup } from './icons.js';

/**
 * Minimal subsequence-based fuzzy match: every character of the
 * query must appear in the target in order (not necessarily
 * contiguous). Tighter, earlier matches score higher, so typing
 * "hist" ranks "Order History" above something that only loosely
 * contains those letters.
 */
function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q); // strong bonus for exact substring
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastMatchIndex === ti - 1 ? 3 : 1; // reward consecutive matches
      lastMatchIndex = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1; // -1 = did not match at all
}

function matchModule(query, mod) {
  const haystacks = [mod.title, mod.subtitle, ...(mod.paletteKeywords || [])];
  const best = Math.max(...haystacks.map((h) => fuzzyScore(query, h)));
  return best;
}

// Deliberately NOT in modules.js: that registry feeds the dashboard
// grid, dock, and shortcut sheet as well as this palette, and this
// entry must never surface anywhere but here. It's also never part
// of the normal fuzzy match - it only appears once the query is
// exactly "hide", so it can't be stumbled into by someone typing
// "hi" or "history". onNavigate (wired in app.js) checks the id
// against HIDDEN_RECORDS_MODULE_ID and routes it to the gatekeeper
// + Hidden Records modal instead of the router.
export const HIDDEN_RECORDS_MODULE_ID = '__hidden-records__';
const HIDDEN_RECORDS_ENTRY = {
  id: HIDDEN_RECORDS_MODULE_ID,
  title: 'Hidden Records',
  subtitle: 'History & Reports for deleted orders',
  icon: 'lock',
  secured: true,
  paletteKeywords: [],
};

export function createCommandPalette({ onNavigate }) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 hidden items-start justify-center pt-[14vh]';
  overlay.innerHTML = `
    <div class="palette-scrim absolute inset-0 bg-black/60 backdrop-blur-md"></div>
    <div class="modal-pop relative w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-modal">
      <div class="flex items-center gap-3 border-b border-border px-4 py-3">
        <span class="h-4.5 w-4.5 text-ink-muted">${iconMarkup('search')}</span>
        <input
          type="text"
          id="palette-input"
          placeholder="Jump to a module... try 'hist' or 'settings'"
          class="w-full bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
          autocomplete="off"
        />
        <kbd class="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-muted">Esc</kbd>
      </div>
      <ul id="palette-results" class="max-h-80 overflow-y-auto p-2"></ul>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#palette-input');
  const resultsEl = overlay.querySelector('#palette-results');
  const scrim = overlay.querySelector('.palette-scrim');
  const card = overlay.querySelector('.modal-pop');

  let filtered = [];
  let selectedIndex = 0;
  // True from the moment an arrow key moves the selection until the
  // mouse is ACTUALLY moved again. Without this, arrowing past the
  // last visible row calls scrollIntoView(), the list scrolls under a
  // stationary cursor, and the browser fires a synthetic `mouseenter`
  // on whichever row slid beneath the pointer - which immediately
  // yanked selectedIndex back to the mouse position. The visible
  // symptom was arrow keys "sticking" or jumping backwards as soon as
  // the selection reached the bottom of the visible list. A real
  // `mousemove` is the only thing that clears it, so hovering still
  // works exactly as before the instant the user touches the mouse.
  let keyboardNavigating = false;

  // Toggles only the highlight-related classes on an already-rendered
  // button, instead of tearing down and rebuilding the whole list.
  // Rebuilding on every hover/arrow-key change was the actual bug:
  // resultsEl has `overflow-y-auto`, and replacing its innerHTML while
  // the user was mid-scroll (either dragging the mouse down the list,
  // or the browser firing a synthetic mouseenter as content slides
  // under a stationary cursor while scrolling) fought with that
  // scrolling, so the list felt like it stopped responding to both
  // the arrow keys and the mouse once you were more than a few rows
  // in. Only `updateFilter` (a genuinely new set of results) needs a
  // full rebuild now.
  function applyHighlight() {
    resultsEl.querySelectorAll('.palette-item').forEach((btn) => {
      const isSelected = Number(btn.dataset.index) === selectedIndex;
      const iconWrap = btn.querySelector('.palette-item-icon');
      btn.classList.toggle('bg-accent/10', isSelected);
      btn.classList.toggle('text-accent', isSelected);
      btn.classList.toggle('text-ink', !isSelected);
      iconWrap?.classList.toggle('bg-accent/15', isSelected);
      iconWrap?.classList.toggle('bg-surface-raised', !isSelected);
    });
    // Keep the highlighted row in view for keyboard navigation - without
    // this, arrowing past the last visible row silently does nothing
    // the user can see, since the list itself never scrolls to follow it.
    const selectedEl = resultsEl.querySelector(`.palette-item[data-index="${selectedIndex}"]`);
    if (typeof selectedEl?.scrollIntoView === 'function') {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderResults() {
    if (filtered.length === 0) {
      resultsEl.innerHTML = `<li class="px-3 py-6 text-center text-sm text-ink-muted">No modules match that.</li>`;
      return;
    }
    resultsEl.innerHTML = filtered
      .map(
        (mod, i) => `
        <li>
          <button type="button" data-index="${i}"
            class="palette-item flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors
                   ${i === selectedIndex ? 'bg-accent/10 text-accent' : 'text-ink hover:bg-surface-raised'}">
            <span class="palette-item-icon flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
              i === selectedIndex ? 'bg-accent/15' : 'bg-surface-raised'
            }">
              <span class="h-4 w-4">${iconMarkup(mod.icon)}</span>
            </span>
            <span class="flex-1">
              <span class="block font-medium">${mod.title}</span>
              <span class="block text-xs text-ink-muted">${mod.subtitle}</span>
            </span>
            ${mod.secured ? `<span class="h-3.5 w-3.5 text-ink-muted">${iconMarkup('lock')}</span>` : ''}
          </button>
        </li>`
      )
      .join('');

    resultsEl.querySelectorAll('.palette-item').forEach((btn) => {
      btn.addEventListener('click', () => commit(Number(btn.dataset.index)));
      btn.addEventListener('mouseenter', () => {
        if (keyboardNavigating) return; // synthetic hover from scrollIntoView, not a real hover
        selectedIndex = Number(btn.dataset.index);
        applyHighlight();
      });
    });
  }

  function updateFilter() {
    const query = input.value.trim();
    filtered = MODULES.map((mod) => ({ mod, score: matchModule(query, mod) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.mod);
    // Exact match only, and checked separately from fuzzyScore above -
    // "hide" must be typed and committed with Enter, not stumbled into
    // by a partial query that happens to fuzzy-match.
    if (query.toLowerCase() === 'hide') {
      filtered = [HIDDEN_RECORDS_ENTRY, ...filtered];
    }
    selectedIndex = 0;
    renderResults();
    // A brand-new result set always starts at the top. Without this,
    // scrolling down a long list and then typing another character
    // left the list scrolled where it was while the highlight reset
    // to row 0 - so the selected row (and the best match) sat
    // invisible above the fold, and Enter appeared to fire the wrong
    // entry.
    resultsEl.scrollTop = 0;
  }

  function commit(index) {
    const mod = filtered[index];
    if (!mod) return;
    close();
    onNavigate(mod.id);
  }

  function isOpen() {
    return !overlay.classList.contains('hidden');
  }

  function open() {
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    input.value = '';
    keyboardNavigating = false;
    updateFilter();
    // The card is built once at startup and only toggled with
    // `hidden` afterwards, so its CSS pop-in animation had already
    // run (invisibly) at app launch and never played again. Removing
    // and re-adding the class on a forced reflow replays it on every
    // open, matching how every other modal in the app enters.
    card.classList.remove('modal-pop');
    void card.offsetWidth;
    card.classList.add('modal-pop');
    input.focus();
    requestAnimationFrame(() => input.focus());
  }

  function close() {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  }

  input.addEventListener('input', updateFilter);
  scrim.addEventListener('click', close);
  // Only a genuine pointer movement hands control back to the mouse.
  // `mousemove` never fires from programmatic scrolling, which is
  // exactly what makes it a reliable signal here.
  resultsEl.addEventListener('mousemove', () => {
    keyboardNavigating = false;
  });

  // Deliberately attached to `document`, not `overlay` or `input`.
  // open() moves focus into the input via requestAnimationFrame,
  // which is asynchronous - a fast keypress (Ctrl+K immediately
  // followed by ArrowDown) can land before that focus actually
  // takes effect. If this listener were scoped to the overlay, that
  // keystroke would fire on whatever WAS focused before (e.g.
  // document.body, which isn't a descendant of overlay) and never
  // reach this handler at all - silently dropping the keystroke.
  // Listening on `document` and gating on isOpen() sidesteps the
  // race entirely, matching the pattern app.js already uses for its
  // own global shortcuts.
  document.addEventListener('keydown', (event) => {
    if (!isOpen()) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length === 0) return; // "No modules match that." - nothing to move through
      keyboardNavigating = true;
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      applyHighlight();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      keyboardNavigating = true;
      selectedIndex = Math.max(selectedIndex - 1, 0);
      applyHighlight();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(selectedIndex);
    }
  });

  return { open, close, isOpen };
}
