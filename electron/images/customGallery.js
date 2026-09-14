'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A small, writable, name-tagged photo gallery - separate from both
 * a specific item's own photo (item-images/item-<id>.<ext>) and the
 * bundled read-only seed-images/ gallery. Lets the admin save a
 * single named photo (e.g. "Crown Crust") from Menu Setup, which
 * Auto-Detect can then match against item names immediately - no
 * need to pick a whole folder just to add one photo.
 *
 * Storage: userData/custom-gallery/<slug>.<ext>, indexed by a
 * manifest.json of [{ name, filename }]. Saving a second photo under
 * the same name replaces the first (by slug), so re-uploading a
 * photo for "Crown Crust" doesn't leave two entries fighting to match.
 */

function galleryDir(userDataDir) {
  const dir = path.join(userDataDir, 'custom-gallery');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath(userDataDir) {
  return path.join(galleryDir(userDataDir), 'manifest.json');
}

function readManifest(userDataDir) {
  const p = manifestPath(userDataDir);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeManifest(userDataDir, entries) {
  fs.writeFileSync(manifestPath(userDataDir), JSON.stringify(entries, null, 2));
}

/** "Crown Crust" -> "crown-crust" - filesystem-safe, human-readable, and stable across renames-with-the-same-name. */
function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'photo';
}

/** @returns {Array<{name: string, filename: string, category: string}>} */
function listImages(userDataDir) {
  return readManifest(userDataDir)
    .map((e) => ({ ...e, category: e.category && String(e.category).trim() ? e.category : 'Uncategorized' }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** @returns {string[]} every distinct category currently in use, sorted - feeds the "existing category" dropdown when adding a photo. */
function listCategories(userDataDir) {
  const set = new Set(listImages(userDataDir).map((e) => e.category));
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} userDataDir
 * @param {string} name - the label Auto-Detect will match against item names
 * @param {string} category - groups photos in the Manage Gallery view (existing or newly typed)
 * @param {string} dataUrl e.g. "data:image/jpeg;base64,/9j/4AAQ..."
 * @returns {{name: string, filename: string, category: string}}
 */
function addImage(userDataDir, name, category, dataUrl) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('A name is required to save a gallery photo.');
  const trimmedCategory = String(category || '').trim() || 'Uncategorized';

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

  const slug = slugify(trimmedName);
  const filename = `${slug}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const dir = galleryDir(userDataDir);

  const entries = readManifest(userDataDir);
  // Replacing a photo saved under the same name: clear out a stale
  // file left over from a previous save with a different extension.
  entries
    .filter((e) => slugify(e.name) === slug && e.filename !== filename)
    .forEach((e) => {
      try {
        fs.unlinkSync(path.join(dir, e.filename));
      } catch {
        // Already gone - fine.
      }
    });

  fs.writeFileSync(path.join(dir, filename), buffer);

  const entry = { name: trimmedName, filename, category: trimmedCategory };
  const withoutOld = entries.filter((e) => slugify(e.name) !== slug);
  writeManifest(userDataDir, [...withoutOld, entry]);
  return entry;
}

function getImageDataUrl(userDataDir, filename) {
  const dir = galleryDir(userDataDir);
  const safeFilename = path.basename(String(filename || ''));
  const fullPath = path.join(dir, safeFilename);
  if (!fullPath.startsWith(dir + path.sep) || !fs.existsSync(fullPath)) return null;

  const ext = path.extname(safeFilename).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const buffer = fs.readFileSync(fullPath);
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

function deleteImage(userDataDir, filename) {
  const safeFilename = path.basename(String(filename || ''));
  const entries = readManifest(userDataDir);
  const remaining = entries.filter((e) => e.filename !== safeFilename);
  writeManifest(userDataDir, remaining);
  try {
    fs.unlinkSync(path.join(galleryDir(userDataDir), safeFilename));
  } catch {
    // Already gone - fine.
  }
}

module.exports = { listImages, listCategories, addImage, getImageDataUrl, deleteImage };
