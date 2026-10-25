'use strict';

import { MODULES } from './modules.js';
import { iconMarkup } from './icons.js';
import { attachRipple } from './ripple.js';

const COLLAPSED_WIDTH = '0px';
const EXPANDED_WIDTH = '76px';

export function createDock({ onNavigate }) {
  const el = document.createElement('nav');
  el.setAttribute('aria-label', 'Module dock');
  el.className =
    'dock relative flex h-full flex-shrink-0 flex-col items-center gap-1 overflow-hidden border-r border-border bg-surface-raised py-4';
  el.style.width = COLLAPSED_WIDTH;

  // Page-name tooltip, shown only while the cursor is over an icon. It
  // lives on <body> (not inside the dock) because the dock is
  // overflow-hidden and would clip it.
  const tip = document.createElement('div');
  tip.className =
    'pointer-events-none fixed z-[9999] hidden whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-white shadow-modal';
  document.body.appendChild(tip);
  const hideTip = () => tip.classList.add('hidden');
  function bindTip(btn, text) {
    btn.setAttribute('aria-label', text);
    btn.addEventListener('mouseenter', () => {
      const r = btn.getBoundingClientRect();
      tip.textContent = text;
      tip.style.left = `${r.right + 10}px`;
      tip.style.top = `${r.top + r.height / 2}px`;
      tip.style.transform = 'translateY(-50%)';
      tip.classList.remove('hidden');
    });
    btn.addEventListener('mouseleave', hideTip);
    btn.addEventListener('click', hideTip);
  }

  const homeBtn = document.createElement('button');
  homeBtn.type = 'button';
  bindTip(homeBtn, 'Dashboard');
  homeBtn.className =
    'ripple-host mb-3 flex h-11 w-11 items-center justify-center rounded-xl text-ink-secondary transition-colors hover:bg-accent/10 hover:text-accent';
  homeBtn.innerHTML = `<span class="h-5 w-5">${iconMarkup('home')}</span>`;
  homeBtn.addEventListener('click', () => onNavigate('dashboard'));
  attachRipple(homeBtn);
  el.appendChild(homeBtn);

  const divider = document.createElement('span');
  divider.className = 'mb-3 h-px w-8 bg-border';
  el.appendChild(divider);

  const buttons = new Map();

  MODULES.forEach((mod, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    bindTip(btn, mod.title);
    btn.dataset.dockModuleId = mod.id;
    btn.className =
      'dock-icon ripple-host relative mb-1 flex h-11 w-11 items-center justify-center rounded-xl text-ink-secondary transition-colors hover:bg-accent/10 hover:text-accent';
    btn.style.animationDelay = `${60 + index * 45}ms`;
    btn.innerHTML = `
      <span class="h-5 w-5">${iconMarkup(mod.icon)}</span>
      ${
        mod.secured
          ? `<span class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface-raised text-accent ring-1 ring-surface-raised">
               <span class="h-3 w-3">${iconMarkup('lockSolid')}</span>
             </span>`
          : ''
      }
    `;
    btn.addEventListener('click', () => onNavigate(mod.id));
    attachRipple(btn);
    buttons.set(mod.id, btn);
    el.appendChild(btn);
  });

  function setActive(routeId) {
    buttons.forEach((btn, id) => {
      const isActive = id === routeId;
      btn.classList.toggle('bg-accent/10', isActive);
      btn.classList.toggle('text-accent', isActive);
      btn.classList.toggle('text-ink-secondary', !isActive);
    });
    homeBtn.classList.toggle('bg-accent/10', routeId === 'dashboard');
    homeBtn.classList.toggle('text-accent', routeId === 'dashboard');
  }

  let visible = false;
  function show() {
    if (visible) return;
    visible = true;
    // Re-trigger the staggered icon-in animation each time the dock
    // manifests (per brief: it should "auto-slide in and fix itself"
    // whenever leaving the dashboard for a deep module).
    buttons.forEach((btn) => {
      btn.style.animation = 'none';
      // eslint-disable-next-line no-unused-expressions
      btn.offsetHeight; // force reflow to restart the animation
      btn.style.animation = '';
    });
    requestAnimationFrame(() => {
      el.style.width = EXPANDED_WIDTH;
    });
  }
  function hide() {
    if (!visible) return;
    visible = false;
    hideTip();
    el.style.width = COLLAPSED_WIDTH;
  }

  return { el, setActive, show, hide };
}
