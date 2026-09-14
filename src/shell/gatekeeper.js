'use strict';

import { posApi } from './posApi.js';
import { iconMarkup } from './icons.js';
import { attachRipple, attachRippleAll } from './ripple.js';
import { toaster } from './toast.js';
import { PATTERN_MIN_LENGTH, patternSvgMarkup, wirePatternEvents } from './patternLock.js';

export function createGatekeeper() {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 hidden items-center justify-center';
  overlay.innerHTML = `
    <div class="gk-scrim absolute inset-0 bg-black/60 backdrop-blur-md"></div>
    <div class="modal-pop relative w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-modal">
      <button type="button" class="gk-close ripple-host absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink">
        <span class="h-4 w-4">${iconMarkup('close')}</span>
      </button>
      <div id="gk-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const scrim = overlay.querySelector('.gk-scrim');
  const closeBtn = overlay.querySelector('.gk-close');
  const bodyEl = overlay.querySelector('#gk-body');
  attachRipple(closeBtn);

  let mode = 'unlock'; // 'unlock' | 'forgot-question' | 'forgot-masterkey' | 'set-new-lock'
  let lockType = 'PIN';
  let pendingResolve = null;

  function isOpen() {
    return !overlay.classList.contains('hidden');
  }

  function grant() {
    const resolve = pendingResolve;
    pendingResolve = null;
    close();
    resolve?.(true);
  }

  function cancel() {
    const resolve = pendingResolve;
    pendingResolve = null;
    close();
    resolve?.(false);
  }

  function close() {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  }

  function showError(container, message) {
    let el = container.querySelector('.gk-error');
    if (!el) {
      el = document.createElement('p');
      el.className = 'gk-error mt-3 text-center text-sm text-accent';
      container.appendChild(el);
    }
    el.textContent = message;
  }

  // ---------------- Unlock view ----------------
  function renderUnlock() {
    bodyEl.innerHTML = `
      <div class="mb-5 flex flex-col items-center text-center">
        <span class="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <span class="h-6 w-6">${iconMarkup('lock')}</span>
        </span>
        <h2 class="font-display text-lg font-bold text-ink">Secured area</h2>
        <p class="text-sm text-ink-secondary">
          ${lockType === 'PIN' ? 'Enter your PIN to continue' : lockType === 'PASSWORD' ? 'Enter your password to continue' : 'Draw your pattern to continue'}
        </p>
      </div>
      <div id="gk-unlock-input"></div>
      <button type="button" id="gk-forgot-link" class="mt-4 w-full text-center text-sm text-ink-muted hover:text-accent">
        Forgot your ${lockType === 'PATTERN' ? 'pattern' : lockType.toLowerCase()}?
      </button>
    `;
    bodyEl.querySelector('#gk-forgot-link').addEventListener('click', () => {
      posApi.security.getQuestion().then((q) => {
        mode = 'forgot-question';
        render(q);
      });
    });

    if (lockType === 'PIN') renderPinInput();
    else if (lockType === 'PASSWORD') renderPasswordInput();
    else renderPatternInput();
  }

  function renderPinInput() {
    let pinBuffer = '';
    const container = bodyEl.querySelector('#gk-unlock-input');
    container.innerHTML = `
      <div id="gk-pin-dots" class="mb-5 flex justify-center gap-3"></div>
      <div class="grid grid-cols-3 gap-2.5">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => numpadBtn(n)).join('')}
        ${numpadBtn('', 'invisible')}
        ${numpadBtn(0)}
        ${numpadBtn('back', '', 'backspace')}
      </div>
    `;
    function numpadBtn(label, extraClass = '', action = null) {
      const value = action || String(label);
      return `
        <button type="button" data-key="${value}" ${extraClass === 'invisible' ? 'tabindex="-1"' : ''}
          class="numpad-btn ripple-host flex h-14 items-center justify-center rounded-xl border border-border text-lg font-medium text-ink transition-colors hover:border-accent/40 hover:bg-accent/5 ${extraClass}">
          ${action === 'backspace' ? '⌫' : label}
        </button>`;
    }
    function redrawDots() {
      const dotsEl = container.querySelector('#gk-pin-dots');
      dotsEl.innerHTML = Array.from({ length: Math.min(Math.max(pinBuffer.length, 4), 6) })
        .map((_, i) => `<span class="h-3 w-3 rounded-full border border-border-strong ${i < pinBuffer.length ? 'bg-accent border-accent' : ''}"></span>`)
        .join('');
    }
    redrawDots();
    container.querySelectorAll('.numpad-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (key === 'backspace') pinBuffer = pinBuffer.slice(0, -1);
        else if (pinBuffer.length < 6) pinBuffer += key;
        redrawDots();
        if (pinBuffer.length >= 4) {
          clearTimeout(container._submitTimer);
          container._submitTimer = setTimeout(() => attemptUnlock(pinBuffer), 150);
        }
      });
    });
    attachRippleAll(container, '.numpad-btn');
  }

  function renderPasswordInput() {
    const container = bodyEl.querySelector('#gk-unlock-input');
    container.innerHTML = `
      <form id="gk-password-form" class="flex flex-col gap-3">
        <input type="password" name="password" autofocus placeholder="Password"
          class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        <button type="submit" class="ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">Unlock</button>
      </form>
    `;
    const form = container.querySelector('#gk-password-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      attemptUnlock(new FormData(form).get('password'));
    });
    attachRipple(form.querySelector('button'));
    form.querySelector('input').focus();
  }

  function renderPatternInput() {
    const container = bodyEl.querySelector('#gk-unlock-input');
    container.innerHTML = `<div class="flex justify-center">${patternSvgMarkup('gk-pattern-svg')}</div>`;
    wirePatternEvents(container.querySelector('#gk-pattern-svg'), {
      onComplete: (path) => attemptUnlock(path.join('-')),
      onError: (msg) => showError(bodyEl, msg),
    });
  }

  async function attemptUnlock(candidate) {
    try {
      const ok = await posApi.security.verify(candidate);
      if (ok) {
        grant();
      } else {
        showError(bodyEl, 'Incorrect. Try again.');
        if (lockType === 'PIN') renderPinInput();
        else if (lockType === 'PATTERN') renderPatternInput();
      }
    } catch (err) {
      showError(bodyEl, err.message);
    }
  }

  // ---------------- Forgot Layer 1: security question ----------------
  function renderForgotQuestion(question) {
    bodyEl.innerHTML = `
      <div class="mb-4 text-center">
        <h2 class="font-display text-lg font-bold text-ink">Reset your lock</h2>
        <p class="text-sm text-ink-secondary">Answer your security question to continue</p>
      </div>
      ${
        question
          ? `
        <form id="gk-question-form" class="flex flex-col gap-3">
          <p class="rounded-xl bg-surface-raised px-3.5 py-2.5 text-sm text-ink-secondary">${question}</p>
          <input type="text" name="answer" autofocus placeholder="Your answer"
            class="rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
          <button type="submit" class="ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">Verify</button>
        </form>
        <button type="button" id="gk-no-answer" class="mt-3 w-full text-center text-sm text-ink-muted hover:text-accent">
          I don't remember the answer either
        </button>`
          : `
        <p class="mb-4 rounded-xl bg-surface-raised px-3.5 py-2.5 text-sm text-ink-secondary">
          No recovery question was ever set up for this device.
        </p>
        <button type="button" id="gk-no-answer" class="ripple-host w-full rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-ink-secondary hover:bg-surface-raised">
          Continue to developer recovery
        </button>`
      }
      <button type="button" id="gk-back-link" class="mt-4 w-full text-center text-sm text-ink-muted hover:text-accent">Back</button>
    `;

    if (question) {
      const form = bodyEl.querySelector('#gk-question-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const answer = new FormData(form).get('answer');
        try {
          const ok = await posApi.security.verifyAnswer(answer);
          if (ok) {
            mode = 'set-new-lock';
            render();
          } else {
            showError(bodyEl, "That answer doesn't match.");
          }
        } catch (err) {
          showError(bodyEl, err.message);
        }
      });
      attachRipple(form.querySelector('button'));
    }

    bodyEl.querySelector('#gk-no-answer').addEventListener('click', () => {
      mode = 'forgot-masterkey';
      render();
    });
    bodyEl.querySelector('#gk-back-link').addEventListener('click', () => {
      mode = 'unlock';
      render();
    });
  }

  // ---------------- Forgot Layer 2: developer master key ----------------
  async function renderForgotMasterKey() {
    const challenge = await posApi.security.getRecoveryChallenge();
    bodyEl.innerHTML = `
      <div class="mb-4 text-center">
        <h2 class="font-display text-lg font-bold text-ink">Developer recovery</h2>
        <p class="text-sm text-ink-secondary">Read this code to your developer/vendor over the phone</p>
      </div>
      <div class="mb-4 rounded-xl border border-dashed border-accent/40 bg-accent/5 px-4 py-3 text-center">
        <span class="font-nums text-xl font-bold tracking-wider text-accent">${challenge}</span>
      </div>
      <form id="gk-masterkey-form" class="flex flex-col gap-3">
        <input type="text" name="masterKey" autofocus placeholder="Enter the key they give you"
          class="rounded-xl border border-border px-3.5 py-2.5 text-sm uppercase tracking-wide focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        <button type="submit" class="ripple-host rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover">Unlock</button>
      </form>
      <button type="button" id="gk-back-link" class="mt-4 w-full text-center text-sm text-ink-muted hover:text-accent">Back</button>
    `;
    const form = bodyEl.querySelector('#gk-masterkey-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = new FormData(form).get('masterKey');
      try {
        const ok = await posApi.security.verifyMasterKey(key);
        if (ok) {
          toaster.success('Recovery verified. Please set a new lock.');
          mode = 'set-new-lock';
          render();
        } else {
          showError(bodyEl, 'That key is not valid.');
        }
      } catch (err) {
        showError(bodyEl, err.message);
      }
    });
    attachRipple(form.querySelector('button'));
    bodyEl.querySelector('#gk-back-link').addEventListener('click', () => {
      mode = 'unlock';
      render();
    });
  }

  // ---------------- Set new lock (after successful recovery) ----------------
  function renderSetNewLock() {
    let newType = 'PIN';
    let newPattern = [];

    bodyEl.innerHTML = `
      <div class="mb-4 text-center">
        <h2 class="font-display text-lg font-bold text-ink">Set a new lock</h2>
        <p class="text-sm text-ink-secondary">Choose a lock type and set new credentials</p>
      </div>
      <div id="gk-type-tabs" class="mb-4 grid grid-cols-3 gap-2"></div>
      <div id="gk-new-credential"></div>
      <div id="gk-question-setup" class="mt-3 flex flex-col gap-2.5">
        <input type="text" name="question" placeholder="Security question (optional)"
          class="rounded-xl border border-border px-3.5 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        <input type="text" name="answer" placeholder="Answer"
          class="rounded-xl border border-border px-3.5 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
      </div>
    `;

    const tabsEl = bodyEl.querySelector('#gk-type-tabs');
    const credEl = bodyEl.querySelector('#gk-new-credential');

    function renderTypeTabs() {
      tabsEl.innerHTML = ['PIN', 'PASSWORD', 'PATTERN']
        .map(
          (t) => `<button type="button" data-t="${t}" class="type-tab ripple-host rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${t === newType ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-secondary'}">${t}</button>`
        )
        .join('');
      tabsEl.querySelectorAll('.type-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          newType = btn.dataset.t;
          renderTypeTabs();
          renderCredentialInput();
        });
      });
      attachRippleAll(tabsEl, '.type-tab');
    }

    function renderCredentialInput() {
      if (newType === 'PATTERN') {
        newPattern = [];
        credEl.innerHTML = `
          <div class="flex justify-center">${patternSvgMarkup('gk-new-pattern-svg')}</div>
          <p class="mt-2 text-center text-xs text-ink-muted">Draw and release to capture your new pattern</p>
        `;
        wirePatternEvents(credEl.querySelector('#gk-new-pattern-svg'), {
          onComplete: (path) => {
            newPattern = path;
            toaster.show('Pattern captured. Tap Save to confirm.', { duration: 1800 });
          },
          onError: (msg) => showError(bodyEl, msg),
        });
      } else {
        credEl.innerHTML = `
          <input type="${newType === 'PIN' ? 'text' : 'password'}" name="credential" inputmode="${newType === 'PIN' ? 'numeric' : 'text'}"
            placeholder="${newType === 'PIN' ? '4-6 digit PIN' : 'New password'}"
            class="w-full rounded-xl border border-border px-3.5 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
        `;
      }
    }

    renderTypeTabs();
    renderCredentialInput();

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ripple-host mt-4 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover';
    saveBtn.textContent = 'Save & Unlock';
    bodyEl.appendChild(saveBtn);
    attachRipple(saveBtn);

    saveBtn.addEventListener('click', async () => {
      let credential;
      if (newType === 'PATTERN') {
        if (newPattern.length < PATTERN_MIN_LENGTH) {
          showError(bodyEl, `Draw a pattern connecting at least ${PATTERN_MIN_LENGTH} dots first.`);
          return;
        }
        credential = newPattern.join('-');
      } else {
        credential = credEl.querySelector('[name="credential"]').value;
        if (newType === 'PIN' && !/^\d{4,6}$/.test(credential)) {
          showError(bodyEl, 'PIN must be 4-6 digits.');
          return;
        }
        if (newType === 'PASSWORD' && credential.length < 4) {
          showError(bodyEl, 'Password must be at least 4 characters.');
          return;
        }
      }
      const question = bodyEl.querySelector('#gk-question-setup [name="question"]').value.trim() || null;
      const answer = bodyEl.querySelector('#gk-question-setup [name="answer"]').value.trim() || null;

      try {
        await posApi.security.setLock({ lockType: newType, credential, securityQuestion: question, securityAnswer: answer });
        toaster.success('New lock saved.');
        lockType = newType;
        grant();
      } catch (err) {
        showError(bodyEl, err.message);
      }
    });
  }

  function render(questionForForgot) {
    if (mode === 'unlock') renderUnlock();
    else if (mode === 'forgot-question') renderForgotQuestion(questionForForgot);
    else if (mode === 'forgot-masterkey') renderForgotMasterKey();
    else if (mode === 'set-new-lock') renderSetNewLock();
  }

  scrim.addEventListener('click', cancel);
  closeBtn.addEventListener('click', cancel);

  async function requireAccess() {
    const configured = await posApi.security.isConfigured();
    if (!configured) return true; // nothing set up yet - leave the area open until admin locks it

    lockType = (await posApi.security.getLockType()) || 'PIN';
    mode = 'unlock';

    return new Promise((resolve) => {
      pendingResolve = resolve;
      overlay.classList.remove('hidden');
      overlay.classList.add('flex');
      render();
    });
  }

  return { requireAccess, isOpen, cancel };
}
