'use strict';

/**
 * Every icon is a raw <svg> string: 24x24 viewBox, single continuous
 * stroke style (stroke-width 1.75, round joins/caps, no fill) to
 * match the brief's "sleek, geometric, uniform single-line icons"
 * requirement. currentColor lets each usage site control color via
 * a text-* Tailwind class rather than baking color into the icon.
 */

const base = (inner) => `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${inner}
  </svg>
`;

export const icons = {
  receipt: base(`
    <path d="M6 3h12v17l-2.5-1.5L13 20l-2.5-1.5L8 20l-2-1.5V3z" />
    <path d="M9 8h6M9 11.5h6M9 15h4" />
  `),
  utensils: base(`
    <path d="M7 3v6a2 2 0 0 0 2 2v10" />
    <path d="M7 3v6M11 3v6" />
    <path d="M17 3c-1.5 1.5-2 3.5-2 6s1 4 2 4v8" />
  `),
  history: base(`
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  `),
  users: base(`
    <circle cx="9" cy="8" r="3.25" />
    <path d="M3.5 20c0-3.2 2.5-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
    <path d="M16 8.5a2.75 2.75 0 1 0 0-5" />
    <path d="M15.5 14.6c2.4.4 4 2.4 4 5.4" />
  `),
  chart: base(`
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  `),
  settings: base(`
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  `),
  lock: base(`
    <rect x="5.5" y="10.5" width="13" height="9" rx="1.75" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
  `),
  // Solid variant for tiny badge contexts (<= ~14px) where a thin
  // stroke anti-aliases into an illegible smudge. Filled shapes hold
  // up far better at micro sizes.
  lockSolid: `
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a5 5 0 0 0-5 5v3.2A3.75 3.75 0 0 0 4.5 13.75v5A3.75 3.75 0 0 0 8.25 22.5h7.5a3.75 3.75 0 0 0 3.75-3.75v-5a3.75 3.75 0 0 0-2.5-3.55V7a5 5 0 0 0-5-5zm-2.75 8V7a2.75 2.75 0 1 1 5.5 0v3z"/>
    </svg>
  `,
  search: base(`
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.3-4.3" />
  `),
  command: base(`
    <path d="M8 5.5A2.5 2.5 0 1 1 10.5 8H8V5.5zM8 8v8M8 16a2.5 2.5 0 1 1-2.5 2.5V16H8zM16 8h2.5A2.5 2.5 0 1 0 16 5.5V8zM16 8v8M16 16h2.5A2.5 2.5 0 1 1 16 18.5V16z" />
  `),
  close: base(`<path d="M6 6l12 12M18 6L6 18" />`),
  keyboard: base(`
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12" />
  `),
  print: base(`
    <path d="M7 8V3h10v5" />
    <rect x="4.5" y="8" width="15" height="8" rx="1.5" />
    <path d="M7 14.5h10V21H7z" />
  `),
  chevronRight: base(`<path d="M9 5l7 7-7 7" />`),
  chevronLeft: base(`<path d="M15 5l-7 7 7 7" />`),
  clock: base(`<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />`),
  home: base(`<path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9.5h12V10" />`),
  edit: base(`
    <path d="M4 20l0.7-3.6L15.5 5.6a1.75 1.75 0 0 1 2.5 0l1.4 1.4a1.75 1.75 0 0 1 0 2.5L8.6 20.3z" />
    <path d="M14 7.5l2.5 2.5" />
  `),
  filter: base(`<path d="M4 5h16M7 12h10M10.5 19h3" />`),
  phone: base(`
    <path d="M6 4.5c.6-.7 1.4-1 2.2-.8l2 .5c.7.2 1.2.8 1.3 1.5l.3 2c.1.6-.1 1.2-.6 1.7l-1.4 1.4a13.5 13.5 0 0 0 5.4 5.4l1.4-1.4c.5-.5 1.1-.7 1.7-.6l2 .3c.7.1 1.3.6 1.5 1.3l.5 2c.2.8-.1 1.6-.8 2.2-.7.6-1.6.9-2.5.8C11.5 20 4 12.5 3.5 5.3c-.1-.9.2-1.8.8-2.5z" />
  `),
  mapPin: base(`
    <path d="M12 21.5c4-4.2 7-8 7-11.5a7 7 0 1 0-14 0c0 3.5 3 7.3 7 11.5z" />
    <circle cx="12" cy="10" r="2.5" />
  `),
  star: base(`<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z" />`),
  send: base(`<path d="M4 12L20 4l-6.5 16-2.5-7-7-2.5z" /><path d="M13.5 13.5L20 4" />`),
  whatsapp: base(`
    <path d="M6.5 17.5L4 20l2.6-2.4A8.5 8.5 0 1 0 4 12a8.4 8.4 0 0 0 1.1 4.2z" />
    <path d="M9 9.3c.1-.6.6-.6 1-.6s.6.1.8.5.5 1.1.5 1.4-.1.5-.3.7-.4.4-.2.8c.2.4.9 1.3 1.9 1.8.8.4 1 .3 1.2.1s.6-.6.8-.5.9.5 1.1.7.2.9-.1 1.2-1 .9-1.9.8c-1.1-.1-3.5-1.3-4.4-3.1-.4-.7-.5-1.5-.4-2 .1-.3.6-.9.9-1.8z" />
  `),
  image: base(`
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.75" />
    <path d="M4 17l5-5 4 4 3-3 4 4" />
  `),
  check: base(`<path d="M5 12.5l4.5 4.5L19 7" />`),
  alertTriangle: base(`
    <path d="M12 4l9.5 16.5H2.5z" />
    <path d="M12 10v4.5M12 17.5h.01" />
  `),
  plus: base(`<path d="M12 5v14M5 12h14" />`),
  chevronDown: base(`<path d="M6 9l6 6 6-6" />`),
  moreVertical: base(`
    <circle cx="12" cy="5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.1" fill="currentColor" stroke="none" />
  `),
  trash: base(`
    <path d="M4 7h16" />
    <path d="M9 7V4.5h6V7" />
    <path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
    <path d="M10 11v6M14 11v6" />
  `),
};

export function iconMarkup(name) {
  return icons[name] || icons.home;
}
