'use strict';

import { iconMarkup } from './icons.js';
import { attachRipple } from './ripple.js';

/**
 * A styled stand-in for window.confirm() - same modal-pop/scrim
 * chrome as the gatekeeper and Hidden Records popups, so every "this
 * is permanent" moment in the app looks and feels the same instead of
 * a plain browser confirm() dialog.
 *
 * Resolves `true` if the person confirmed, `false` for Cancel, the
 * scrim, or Escape. When `requireTypedConfirmation` is set, Confirm
 * stays disabled until the exact string is typed - reserved for the
 * genuinely irreversible actions (hard-deleting a customer profile),
 * not every delete in the app.
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.message]
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.cancelLabel]
 * @param {'danger'|'default'} [opts.tone]
 * @param {string|null} [opts.requireTypedConfirmation]
 * @returns {Promise<boolean>}
 */
export function confirmAction({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  tone = 'danger',
  requireTypedConfirmation = null,
} = {}) {
  return new Promise((resolve) => {
    const isDanger = tone === 'danger';
    const iconTone = isDanger ? 'bg-red-50 text-red-600' : 'bg-accent/10 text-accent';
    const btnTone = isDanger ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-hover';

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[70] flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="cf-scrim absolute inset-0 bg-black/60 backdrop-blur-md"></div>
      <div class="modal-pop relative w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-modal">
        <div class="mb-4 flex items-start gap-3">
          <span class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${iconTone}">
            <span class="h-5 w-5">${iconMarkup(isDanger ? 'alertTriangle' : 'lock')}</span>
          </span>
          <div class="pt-0.5">
            <h2 class="font-display text-base font-bold text-ink">${title}</h2>
            <p class="mt-1 text-sm text-ink-secondary">${message}</p>
          </div>
        </div>
        ${
          requireTypedConfirmation
            ? `<label class="mb-4 flex flex-col gap-1 text-xs text-ink-secondary">
                 Type "<span class="font-medium text-ink">${requireTypedConfirmation}</span>" to confirm
                 <input type="text" id="cf-typed" autocomplete="off"
                   class="rounded-lg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
               </label>`
            : ''
        }
        <div class="flex justify-end gap-2">
          <button type="button" id="cf-cancel"
            class="ripple-host rounded-xl border border-border px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-surface-raised">
            ${cancelLabel}
          </button>
          <button type="button" id="cf-confirm"
            class="ripple-host rounded-xl px-4 py-2 text-sm font-medium text-white transition-colors ${btnTone}"
            ${requireTypedConfirmation ? 'disabled' : ''}>
            ${confirmLabel}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const confirmBtn = overlay.querySelector('#cf-confirm');
    const cancelBtn = overlay.querySelector('#cf-cancel');
    attachRipple(confirmBtn);
    attachRipple(cancelBtn);

    function setConfirmDisabled(disabled) {
      confirmBtn.disabled = disabled;
      confirmBtn.classList.toggle('opacity-50', disabled);
      confirmBtn.classList.toggle('cursor-not-allowed', disabled);
    }

    function cleanup(result) {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(result);
    }
    function onKeydown(event) {
      if (event.key === 'Escape') cleanup(false);
    }
    document.addEventListener('keydown', onKeydown);

    if (requireTypedConfirmation) {
      setConfirmDisabled(true);
      const typedInput = overlay.querySelector('#cf-typed');
      typedInput.addEventListener('input', () => {
        setConfirmDisabled(typedInput.value.trim() !== requireTypedConfirmation);
      });
      requestAnimationFrame(() => typedInput.focus());
    }

    overlay.querySelector('.cf-scrim').addEventListener('click', () => cleanup(false));
    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => {
      if (confirmBtn.disabled) return;
      cleanup(true);
    });
  });
}
