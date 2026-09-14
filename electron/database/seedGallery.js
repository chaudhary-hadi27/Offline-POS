'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The bundled AI-generated photo gallery Menu Setup's "Choose from
 * Gallery" picker reads from - electron/database/seed-images/<Category
 * folder name>/<image files>. This is entirely separate from a
 * restaurant's live userData/item-images/ - it's read-only, ships
 * inside the installer (covered by the electron/**\/* glob in
 * package.json already), and is never written to at runtime.
 *
 * The folder name IS the category name (e.g. "Pizzas (Large)"), so an
 * item being edited can auto-expand its own category in the picker
 * with zero extra bookkeeping - no JSON mapping file to keep in sync.
 */

const GALLERY_DIR = path.join(__dirname, 'seed-images');
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const MIME_BY_EXT = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };

/** @returns {Array<{category: string, images: string[]}>} - categories with no image files are omitted. */
function listGallery() {
  if (!fs.existsSync(GALLERY_DIR)) return [];
  return fs
    .readdirSync(GALLERY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((dir) => {
      const categoryPath = path.join(GALLERY_DIR, dir.name);
      const images = fs
        .readdirSync(categoryPath)
        .filter((f) => IMAGE_EXT_RE.test(f))
        .sort((a, b) => a.localeCompare(b));
      return { category: dir.name, images };
    })
    .filter((c) => c.images.length > 0)
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * @param {string} category - folder name, exactly as returned by listGallery()
 * @param {string} filename - image filename, exactly as returned by listGallery()
 * @returns {string|null} a "data:image/...;base64,..." data URL, or null if not found
 */
function getGalleryImageDataUrl(category, filename) {
  // category/filename arrive from the renderer - path.basename() strips
  // any "../" a malformed call might contain before it ever touches
  // the filesystem, and the startsWith() check below is a second,
  // belt-and-suspenders guard against ever reading outside this folder.
  const safeCategory = path.basename(String(category || ''));
  const safeFilename = path.basename(String(filename || ''));
  const fullPath = path.join(GALLERY_DIR, safeCategory, safeFilename);
  if (!fullPath.startsWith(GALLERY_DIR + path.sep) || !fs.existsSync(fullPath)) return null;

  const ext = path.extname(safeFilename).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;

  const buffer = fs.readFileSync(fullPath);
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

module.exports = { listGallery, getGalleryImageDataUrl };
