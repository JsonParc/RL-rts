Map image workflow

1. Put your painted map image at:
   public/assets/maps/world-map.png

1-1. Auto-generate base map image from terrain:
   npm run generate:map-image
   (uses terrain-grid.json -> world-map.png)

2. The game renders this file as the main world map.
   If the file is missing, it falls back to a plain water background.

3. Land coordinates are exported at:
   /api/map/land-cells
   and also written to:
   public/assets/maps/land-cells.json

4. Coordinate format:
   - landCells: [gridX, gridY]
   - grid size is in "gridSize"
   - one pixel per grid cell is recommended for painting (ex: 800x800)

5. Browser helper:
   run downloadLandCells() in devtools console to download land-cells.json.
