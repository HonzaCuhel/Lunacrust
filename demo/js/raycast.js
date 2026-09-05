// Amanatides & Woo voxel traversal - the standard "walk the grid, always step
// the axis whose next boundary is nearest" DDA. Exact, and it never misses a
// block the way fixed-step sampling does.

export function raycastVoxel(world, ox, oy, oz, dx, dy, dz, maxDist = 6, hitTest) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ ? Math.abs(1 / dz) : Infinity;

  const bound = (o, s) => (s > 0 ? Math.floor(o) + 1 - o : o - Math.floor(o));
  let tMaxX = stepX ? bound(ox, stepX) * tDeltaX : Infinity;
  let tMaxY = stepY ? bound(oy, stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ ? bound(oz, stepZ) * tDeltaZ : Infinity;

  let face = [0, 0, 0];
  let t = 0;
  const test = hitTest ?? ((id) => id !== 0);

  while (t <= maxDist) {
    const id = world.getBlock(x, y, z);
    if (test(id)) {
      return { x, y, z, id, face, dist: t };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; face = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; face = [0, -stepY, 0];
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = [0, 0, -stepZ];
    }
  }
  return null;
}
