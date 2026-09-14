'use strict';

/**
 * One registry feeds four different UI surfaces (dashboard grid, dock,
 * command palette, footer shortcut hints), so a module can never show
 * up in one place and be missing from another.
 */
export const MODULES = [
  {
    id: 'new-order',
    title: 'New Order',
    subtitle: 'Punch a new order',
    icon: 'receipt',
    secured: false,
    block: 'cashier',
    paletteKeywords: ['new order', 'punch order', 'new'],
    shortcuts: [
      { keys: 'Ctrl+/', label: 'Help' },
      { keys: 'Ctrl+P', label: 'Print receipt' },
      { keys: 'Esc', label: 'Clear cart' },
    ],
  },
  {
    id: 'menu-setup',
    title: 'Menu Setup',
    subtitle: 'Manage items & pricing',
    icon: 'utensils',
    secured: false,
    block: 'cashier',
    paletteKeywords: ['menu setup', 'manage items', 'menu'],
    shortcuts: [
      { keys: 'Ctrl+/', label: 'Help' },
      { keys: 'Ctrl+N', label: 'New item' },
      { keys: 'Esc', label: 'Close editor' },
    ],
  },
  {
    id: 'order-history',
    title: 'Order History',
    subtitle: 'Logs & reprints',
    icon: 'history',
    secured: false,
    block: 'cashier',
    paletteKeywords: ['order history', 'logs', 'hist', 'reprint'],
    shortcuts: [
      { keys: 'Ctrl+/', label: 'Help' },
      { keys: 'Ctrl+P', label: 'Reprint selected' },
      { keys: 'Ctrl+F', label: 'Find by date' },
    ],
  },
  {
    id: 'customers',
    title: 'Customers',
    subtitle: 'Customer directory',
    icon: 'users',
    secured: true,
    block: 'admin',
    paletteKeywords: ['customers', 'customer database', 'cust'],
    shortcuts: [
      { keys: 'Ctrl+/', label: 'Help' },
      { keys: 'Ctrl+N', label: 'New customer' },
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics & Reports',
    subtitle: 'Sales & performance',
    icon: 'chart',
    secured: true,
    block: 'admin',
    paletteKeywords: ['analytics', 'reports', 'finance', 'stats'],
    shortcuts: [
      { keys: 'Ctrl+/', label: 'Help' },
      { keys: 'Ctrl+E', label: 'Export report' },
    ],
  },
  {
    id: 'whatsapp-deals',
    title: 'WhatsApp Deals',
    subtitle: 'Bulk deal sender',
    icon: 'whatsapp',
    secured: true,
    block: 'admin',
    paletteKeywords: ['whatsapp', 'deals', 'bulk send', 'marketing', 'campaign'],
    shortcuts: [
      { keys: 'Ctrl+/', label: 'Help' },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    subtitle: 'Configuration & Day Close',
    icon: 'settings',
    secured: true,
    block: 'admin',
    paletteKeywords: ['settings', 'control panel', 'day close', 'day end', 'tax', 'printer'],
    shortcuts: [
      { keys: 'Ctrl+/', label: 'Help' },
      { keys: 'Ctrl+D', label: 'Close day' },
    ],
  },
];

export const DASHBOARD_SHORTCUTS = [
  { keys: 'Ctrl+K', label: 'Command palette' },
  { keys: 'Ctrl+/', label: 'All shortcuts' },
];

export function getModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}
