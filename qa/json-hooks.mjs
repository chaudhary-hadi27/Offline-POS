// Lets Node import "x.json" without an import attribute, the way Vite does (used only by qa/ui-smoke.mjs).
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: 'json' } });
  return nextLoad(url, context);
}
