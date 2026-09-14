'use strict';

import { renderDashboard } from './dashboard.js';
import { renderModulePlaceholder } from './modulePlaceholder.js';
import { createDock } from './dock.js';
import { shellStore } from './state.js';
import { getModule } from './modules.js';
import { renderMenuSetup } from '../modules/menuSetup.js';
import { renderNewOrder } from '../modules/newOrder.js';
import { renderOrderHistory } from '../modules/orderHistory.js';
import { renderCustomers } from '../modules/customers.js';
import { renderAnalytics } from '../modules/analytics.js';
import { renderSettings } from '../modules/settings.js';
import { renderWhatsappDeals } from '../modules/whatsappDeals.js';

// Real module renderers built so far. Anything not listed here falls
// back to the placeholder (nothing should be missing by Phase 4's end).
const MODULE_RENDERERS = {
  'new-order': renderNewOrder,
  'menu-setup': renderMenuSetup,
  'order-history': renderOrderHistory,
  customers: renderCustomers,
  analytics: renderAnalytics,
  settings: renderSettings,
  'whatsapp-deals': renderWhatsappDeals,
};

/**
 * Builds the persistent layout:
 *   [ dock (hidden on dashboard) | content stage (sliding layers) ]
 *
 * The workspace-slide effect (brief section 3): the outgoing page
 * slides out to the LEFT while the incoming page slides in from the
 * RIGHT. This is applied uniformly for every route change, matching
 * the brief's literal description rather than branching into
 * separate "forward"/"back" directions.
 */
export function createRouter({ onRequestPalette, requireAccess }) {
  const root = document.createElement('div');
  root.className = 'flex h-full w-full overflow-hidden bg-surface';

  const stage = document.createElement('div');
  stage.className = 'relative h-full flex-1 overflow-hidden';

  const dock = createDock({ onNavigate: (id) => navigate(id) });

  root.appendChild(dock.el);
  root.appendChild(stage);

  let activeLayer = null;

  function buildContent(routeId) {
    if (routeId === 'dashboard') return renderDashboard({ onNavigate: handleNavigateRequest });
    const renderer = MODULE_RENDERERS[routeId];
    return renderer ? renderer() : renderModulePlaceholder(routeId);
  }

  function handleNavigateRequest(id) {
    if (id === '__open-palette__') {
      onRequestPalette();
      return;
    }
    navigate(id);
  }

  let secureSessionActive = false;

  async function navigate(routeId) {
    const current = shellStore.get().route;
    if (routeId === current) return;

    const targetModule = getModule(routeId);
    if (targetModule?.secured) {
      if (!secureSessionActive) {
        const granted = await requireAccess();
        if (!granted) return; // cancelled at the gatekeeper - stay put
        secureSessionActive = true;
      }
    } else {
      secureSessionActive = false; // leaving the secured area re-locks it
    }

    const content = buildContent(routeId);
    const layer = document.createElement('div');
    layer.className = 'route-layer route-layer--entering';
    layer.appendChild(content);
    stage.appendChild(layer);

    // Force a reflow so the browser registers the starting transform
    // before we flip to the active state - otherwise the transition
    // is skipped and the layer just "pops" into place.
    // eslint-disable-next-line no-unused-expressions
    layer.offsetHeight;

    const outgoing = activeLayer;
    requestAnimationFrame(() => {
      layer.classList.remove('route-layer--entering');
      layer.classList.add('route-layer--active');
      if (outgoing) {
        outgoing.classList.remove('route-layer--active');
        outgoing.classList.add('route-layer--exiting');
      }
    });

    if (outgoing) {
      outgoing.addEventListener(
        'transitionend',
        () => {
          const content = outgoing.firstElementChild;
          if (content && typeof content._cleanup === 'function') content._cleanup();
          outgoing.remove();
        },
        { once: true }
      );
    }

    activeLayer = layer;

    if (routeId === 'dashboard') {
      dock.hide();
    } else {
      dock.show();
    }
    dock.setActive(routeId);

    shellStore.set({ route: routeId });
  }

  // First paint: mount the dashboard with no transition (nothing to
  // slide away from yet).
  function mountInitial() {
    const content = buildContent('dashboard');
    const layer = document.createElement('div');
    layer.className = 'route-layer route-layer--active';
    layer.appendChild(content);
    stage.appendChild(layer);
    activeLayer = layer;
    dock.setActive('dashboard');
  }

  mountInitial();

  return { el: root, navigate };
}
