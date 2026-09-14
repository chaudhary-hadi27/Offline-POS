'use strict';

import { posApi } from '../../shell/posApi.js';

// relativePath -> Promise<dataUrl|null>. Module-level so it's shared
// across every screen that renders item thumbnails in a session -
// switching between Menu Setup and New Order doesn't re-fetch images
// already seen.
const cache = new Map();

function getItemImageUrl(relativePath) {
  if (!relativePath) return Promise.resolve(null);
  if (!cache.has(relativePath)) {
    cache.set(relativePath, posApi.items.getImage(relativePath).catch(() => null));
  }
  return cache.get(relativePath);
}

/** Call after rendering markup that included <img data-image-path="..."> placeholders. */
export function hydrateItemImages(root) {
  root.querySelectorAll('img[data-image-path]').forEach((img) => {
    const relativePath = img.dataset.imagePath;
    getItemImageUrl(relativePath).then((url) => {
      if (url && img.isConnected) {
        img.src = url;
        img.classList.remove('opacity-0');
      }
    });
  });
}

export function invalidateItemImage(relativePath) {
  if (relativePath) cache.delete(relativePath);
}
