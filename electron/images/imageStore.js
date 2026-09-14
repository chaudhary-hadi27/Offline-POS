'use strict';

const fs = require('fs');
const path = require('path');

/**
 * DESIGN: images are never stored as blobs in SQLite.
 *
 * A restaurant menu might grow to hundreds of items; storing even
 * modestly-sized images as BLOBs in the same file as every order/
 * shift/customer row would make the whole database bigger and every
 * unrelated query (order history, analytics) slower over time as
 * that file grows, since SQLite has to page through more data on
 * disk. Keeping images as small separate JPEG files means the
 * .sqlite file stays tiny and fast indefinitely, no matter how many
 * item photos get added.
 *
 * The renderer is responsible for compressing the image (via
 * <canvas>) down to a small thumbnail BEFORE sending it here - this
 * module just writes whatever bytes it's given. See
 * src/modules/shared/imageResize.js for that client-side resize step.
 */

function imagesDir(userDataDir) {
  const dir = path.join(userDataDir, 'item-images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} userDataDir
 * @param {number} itemId
 * @param {string} dataUrl  e.g. "data:image/jpeg;base64,/9j/4AAQ..."
 * @returns {string} relative path (e.g. "item-images/item-42.jpg") to store in the DB
 */
function saveItemImage(userDataDir, itemId, dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Unsupported image format - expected a base64 JPEG/PNG/WebP data URL.');
  }
  const [, ext, base64] = match;
  const buffer = Buffer.from(base64, 'base64');

  // A generous ceiling in case a client-side resize step is ever
  // skipped/bypassed - the renderer should already be sending
  // something far smaller than this (tens of KB, not megabytes).
  const MAX_BYTES = 2 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    throw new Error('Image is too large even after compression. Try a smaller photo.');
  }

  const filename = `item-${itemId}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const fullPath = path.join(imagesDir(userDataDir), filename);
  fs.writeFileSync(fullPath, buffer);
  return `item-images/${filename}`;
}

function dealImagesDir(userDataDir) {
  const dir = path.join(userDataDir, 'deal-images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Same idea as saveItemImage(), for the WhatsApp Deal Sender's saved
 * templates - kept as its own folder/function (instead of reusing
 * item-images) so a deleted deal template can never be confused with,
 * or accidentally clobber, a menu item's photo.
 *
 * @param {string} userDataDir
 * @param {number} templateId
 * @param {string} dataUrl
 * @returns {string} relative path (e.g. "deal-images/template-7.jpg") to store in the DB
 */
function saveTemplateImage(userDataDir, templateId, dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Unsupported image format - expected a base64 JPEG/PNG/WebP data URL.');
  }
  const [, ext, base64] = match;
  const buffer = Buffer.from(base64, 'base64');

  const MAX_BYTES = 2 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    throw new Error('Image is too large even after compression. Try a smaller photo.');
  }

  const filename = `template-${templateId}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const fullPath = path.join(dealImagesDir(userDataDir), filename);
  fs.writeFileSync(fullPath, buffer);
  return `deal-images/${filename}`;
}

function getItemImageDataUrl(userDataDir, relativePath) {
  if (!relativePath) return null;
  const fullPath = path.join(userDataDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const ext = path.extname(fullPath).slice(1);
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const buffer = fs.readFileSync(fullPath);
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

function deleteItemImage(userDataDir, relativePath) {
  if (!relativePath) return;
  try {
    fs.unlinkSync(path.join(userDataDir, relativePath));
  } catch {
    // Already gone, or never existed - fine either way.
  }
}

module.exports = { saveItemImage, saveTemplateImage, getItemImageDataUrl, deleteItemImage };
