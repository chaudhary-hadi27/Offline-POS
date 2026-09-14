'use strict';

/**
 * Resizes/crops an uploaded image file down to a small square JPEG
 * thumbnail entirely in the renderer (via <canvas>), before anything
 * is sent over IPC. A typical phone photo (3-8MB) becomes a ~15-40KB
 * thumbnail - this is what keeps per-item images cheap regardless of
 * what the admin originally uploads.
 *
 * @param {File} file
 * @param {{ size?: number, quality?: number }} opts
 * @returns {Promise<string>} a "data:image/jpeg;base64,..." data URL
 */
export function resizeImageToThumbnail(file, { size = 320, quality = 0.72 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please choose an image file.'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file doesn\'t look like a valid image.'));
      img.onload = () => {
        try {
          // Contain-fit: scale the WHOLE image down to fit inside the
          // square canvas without cropping, then center it. Any
          // leftover strip (when the source photo isn't already
          // square - the normal case for phone/gallery photos) is
          // padded with a neutral fill instead of being cut off.
          // Previously this cover-cropped to a square, which silently
          // chopped the top/bottom or left/right off most uploads.
          const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
          const drawWidth = img.naturalWidth * scale;
          const drawHeight = img.naturalHeight * scale;
          const dx = (size - drawWidth) / 2;
          const dy = (size - drawHeight) / 2;

          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.fillStyle = '#F8F9FB';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, drawWidth, drawHeight);

          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
