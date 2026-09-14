'use strict';

import { iconMarkup } from './icons.js';

function createToaster() {
  const root = document.createElement('div');
  root.className =
    'pointer-events-none fixed bottom-14 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2';
  document.body.appendChild(root);

  function show(message, { type = 'success', duration = 3200, action = null } = {}) {
    // Solid, high-contrast fills instead of a faint color tint - a
    // washed-out 10%-opacity background reads as "barely different
    // from white" at a glance, which is exactly the wrong look for an
    // error a cashier needs to notice immediately.
    const tone = type === 'error' ? 'bg-accent text-white' : 'bg-success text-white';
    const icon = type === 'error' ? 'alertTriangle' : 'check';

    const el = document.createElement('div');
    el.className = `modal-pop pointer-events-auto flex items-center gap-2.5 rounded-xl ${tone} px-4 py-3 text-sm shadow-card-hover`;

    const iconEl = document.createElement('span');
    iconEl.className = 'h-4 w-4 flex-shrink-0';
    iconEl.innerHTML = iconMarkup(icon);
    el.appendChild(iconEl);

    const messageEl = document.createElement('span');
    messageEl.className = 'flex-1 font-medium';
    messageEl.textContent = message;
    el.appendChild(messageEl);

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      el.style.transition = 'opacity 200ms ease, transform 200ms ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 220);
    }

    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flex-shrink-0 rounded-lg border border-white/50 px-2.5 py-1 text-xs font-semibold hover:bg-white/15';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        action.onClick();
        dismiss();
      });
      el.appendChild(btn);
    }

    root.appendChild(el);

    // Toasts with an action get more time on screen - the cashier
    // needs a moment to notice and reach for the button, not just read
    // a line of text.
    setTimeout(dismiss, action ? Math.max(duration, 6000) : duration);
  }

  return {
    show,
    success: (msg, opts) => show(msg, { ...opts, type: 'success' }),
    error: (msg, opts) => show(msg, { ...opts, type: 'error' }),
  };
}

export const toaster = createToaster();
