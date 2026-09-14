'use strict';

/**
 * Attaches the "soft white ripple from the click point" feedback
 * (brief section 3) to any element. Call once per element; safe to
 * call on elements that get re-rendered since it only reads the
 * click event, not stored state.
 */
export function attachRipple(el) {
  el.classList.add('ripple-host');
  el.addEventListener('click', (event) => {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.6;
    const span = document.createElement('span');
    span.className = 'ripple-span';
    span.style.width = `${size}px`;
    span.style.height = `${size}px`;
    span.style.left = `${event.clientX - rect.left - size / 2}px`;
    span.style.top = `${event.clientY - rect.top - size / 2}px`;
    el.appendChild(span);
    span.addEventListener('animationend', () => span.remove());
  });
}

/** Convenience: attach to every element matching a selector inside a root. */
export function attachRippleAll(root, selector) {
  root.querySelectorAll(selector).forEach(attachRipple);
}
