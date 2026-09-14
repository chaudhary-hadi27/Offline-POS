'use strict';

export const PATTERN_NODES = [
  { i: 1, x: 40, y: 40 }, { i: 2, x: 120, y: 40 }, { i: 3, x: 200, y: 40 },
  { i: 4, x: 40, y: 120 }, { i: 5, x: 120, y: 120 }, { i: 6, x: 200, y: 120 },
  { i: 7, x: 40, y: 200 }, { i: 8, x: 120, y: 200 }, { i: 9, x: 200, y: 200 },
];
export const PATTERN_MIN_LENGTH = 4;

export function patternSvgMarkup(id) {
  return `
    <svg id="${id}" viewBox="0 0 240 240" width="220" height="220" class="touch-none select-none">
      ${PATTERN_NODES.map(
        (n) => `
        <g data-node="${n.i}">
          <circle cx="${n.x}" cy="${n.y}" r="18" fill="none" stroke="#E5E7EB" stroke-width="2" class="pattern-ring" />
          <circle cx="${n.x}" cy="${n.y}" r="7" fill="#D1D5DB" class="pattern-dot" />
        </g>`
      ).join('')}
    </svg>`;
}

/**
 * Wires mouse-drag pattern capture onto an SVG built by
 * patternSvgMarkup(). Calls onComplete(path) with an array of node
 * indices (e.g. [1,5,9,8,7]) once the user releases the mouse having
 * connected at least PATTERN_MIN_LENGTH dots. Calls onError(message)
 * if they release too early.
 */
export function wirePatternEvents(svg, { onComplete, onError }) {
  let path = [];
  let drawing = false;
  const lines = [];

  const nodeAt = (i) => PATTERN_NODES.find((n) => n.i === i);

  function svgPoint(evt) {
    const rect = svg.getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left) * (240 / rect.width),
      y: (evt.clientY - rect.top) * (240 / rect.height),
    };
  }

  function highlight(i) {
    const g = svg.querySelector(`g[data-node="${i}"]`);
    g.querySelector('.pattern-ring').setAttribute('stroke', '#DC2626');
    g.querySelector('.pattern-dot').setAttribute('fill', '#DC2626');
  }

  function drawSegment(a, b) {
    const na = nodeAt(a);
    const nb = nodeAt(b);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', na.x);
    line.setAttribute('y1', na.y);
    line.setAttribute('x2', nb.x);
    line.setAttribute('y2', nb.y);
    line.setAttribute('stroke', '#DC2626');
    line.setAttribute('stroke-width', '4');
    line.setAttribute('stroke-linecap', 'round');
    svg.insertBefore(line, svg.firstChild);
    lines.push(line);
  }

  function reset() {
    path = [];
    lines.forEach((l) => l.remove());
    lines.length = 0;
    svg.querySelectorAll('.pattern-ring').forEach((el) => el.setAttribute('stroke', '#E5E7EB'));
    svg.querySelectorAll('.pattern-dot').forEach((el) => el.setAttribute('fill', '#D1D5DB'));
  }

  function hitTestNode(point) {
    return PATTERN_NODES.find((n) => Math.hypot(n.x - point.x, n.y - point.y) <= 20);
  }

  function pointerDown(evt) {
    reset();
    const hit = hitTestNode(svgPoint(evt));
    if (!hit) return;
    drawing = true;
    path = [hit.i];
    highlight(hit.i);
    window.addEventListener('mousemove', pointerMove);
    window.addEventListener('mouseup', pointerUp, { once: true });
  }

  function pointerMove(evt) {
    if (!drawing) return;
    const hit = hitTestNode(svgPoint(evt));
    if (hit && !path.includes(hit.i)) {
      drawSegment(path[path.length - 1], hit.i);
      path.push(hit.i);
      highlight(hit.i);
    }
  }

  function pointerUp() {
    drawing = false;
    window.removeEventListener('mousemove', pointerMove);
    if (path.length >= PATTERN_MIN_LENGTH) {
      onComplete([...path]);
    } else if (path.length > 0) {
      onError?.(`Connect at least ${PATTERN_MIN_LENGTH} dots.`);
      setTimeout(reset, 400);
    }
  }

  svg.addEventListener('mousedown', pointerDown);
  return { reset };
}
