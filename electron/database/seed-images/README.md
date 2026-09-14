# Menu photo gallery

Drop your AI-generated menu photos in here, organized into folders by
category. Menu Setup's "Choose from Gallery" button reads straight from
this folder - no JSON, no filename typing, no manual matching.

## Structure

```
seed-images/
  Pizzas (Large)/
    crown-crust.jpg
    supreme.jpg
  Burgers/
    zinger-burger.jpg
    beef-burger.png
```

**The folder name IS the category name** - spell it exactly like it
appears in Menu Setup (matching capitalization/spacing isn't required
to *work*, but matching it means an item's own category opens
pre-expanded in the picker automatically). The image filenames inside
don't matter - name them however's convenient, they're just shown as a
thumbnail grid to click.

## How it's used

1. In Menu Setup, add/edit an item and click **"Choose from Gallery"**
   next to the usual "Choose photo" upload button.
2. The picker opens with the item's own category's folder expanded -
   click any thumbnail to use it.
3. It goes through the exact same compression step as a manual upload,
   so there's no size limit to worry about here - drop the AI tool's
   original output as-is.

## Rules

- **Format**: `.jpg`, `.png`, or `.webp`.
- **This folder ships inside the installer** (already covered by the
  `electron/**/*` line in `package.json` - no extra build config
  needed), so it's available to every client, every install, offline.
- Purely a picking gallery - selecting one just fills the normal photo
  field for that item, the same as uploading from disk. Nothing here
  is required, and an item with no folder/photo works exactly as it
  does today.
