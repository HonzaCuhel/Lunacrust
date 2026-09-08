// An original, hand-composed display scene using Lunacrust's real block atlas.
// This is a miniature illustration, not a saved or generated playable world.
import * as THREE from "./demo/vendor/three.module.js";
import { BY_KEY } from "./demo/js/blocks.js";
import { TILE_INDEX, tileUV } from "./demo/js/textures.js";

const faces = [
  {
    n: [1, 0, 0],
    v: [
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
    shade: 0.78,
  },
  {
    n: [-1, 0, 0],
    v: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    shade: 0.78,
  },
  {
    n: [0, 1, 0],
    v: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
    shade: 1,
  },
  {
    n: [0, -1, 0],
    v: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    shade: 0.55,
  },
  {
    n: [0, 0, 1],
    v: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    shade: 0.88,
  },
  {
    n: [0, 0, -1],
    v: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    shade: 0.88,
  },
];
const uvCorners = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export function buildDiorama(planet, atlas, compact = false) {
  const cells = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const put = (x, y, z, block) => {
    if (!BY_KEY.has(block)) throw Error(`Unknown diorama block: ${block}`);
    cells.set(key(x, y, z), { x, y, z, block: BY_KEY.get(block) });
  };
  const { surface, subsurface, deep } = planet.terrain.layers;
  const rx = compact ? 2.5 : 4.8,
    rz = compact ? 2.2 : 3.8;
  for (let x = -5; x <= 4; x++)
    for (let z = -4; z <= 3; z++) {
      const edge = ((x + 0.5) / rx) ** 2 + ((z + 0.5) / rz) ** 2;
      if (edge > 1) continue;
      const bottom = compact
        ? -1
        : -Math.max(1, Math.floor((1 - edge) * 3) + 1);
      for (let y = bottom; y <= 0; y++)
        put(x, y, z, y === 0 ? surface : y === -1 ? subsurface : deep);
      if (!compact && z < -1 && edge < 0.75) put(x, 1, z, surface);
    }
  if (!compact) {
    const pillar = (x, z, height, block) => {
      for (let y = 2; y <= height + 1; y++) put(x, y, z, block);
    };
    if (planet.id === "earth" || planet.id === "titan") {
      const alien = planet.id === "titan";
      pillar(-3, -2, 3, alien ? "alien_log" : "log");
      for (let x = -4; x <= -2; x++)
        for (let z = -3; z <= -1; z++) {
          put(x, 4, z, alien ? "alien_leaves" : "leaves");
          if (x === -3 || z === -2)
            put(x, 5, z, alien ? "alien_leaves" : "leaves");
        }
    } else if (planet.id === "europa" || planet.id === "jupiter") {
      const ice = planet.id === "europa" ? "crystal_block" : "helium_ice";
      pillar(-3, -2, 3, ice);
      pillar(-2, -3, 2, surface);
      pillar(2, -2, 2, ice);
    } else {
      pillar(-3, -2, planet.id === "luna" ? 1 : 3, deep);
      pillar(-2, -3, 2, deep);
      pillar(2, -3, 1, surface);
    }
    if (planet.terrain.sea) {
      for (let x = 2; x <= 3; x++)
        for (let z = -1; z <= 1; z++) {
          if (cells.has(key(x, 0, z))) put(x, 0, z, planet.terrain.sea);
        }
    }
    // A few exposed geological layers give the cutaway its floating silhouette.
    put(-3, -3, 1, deep);
    put(2, -2, -3, deep);
  }
  const positions = [],
    normals = [],
    colors = [],
    uvs = [],
    indices = [];
  for (const cell of cells.values()) {
    const { x, y, z, block } = cell;
    faces.forEach((face, f) => {
      if (cells.has(key(x + face.n[0], y + face.n[1], z + face.n[2]))) return;
      const name = block.tex[f === 2 ? 0 : f === 3 ? 2 : 1];
      const tile = TILE_INDEX.get(name);
      if (tile === undefined) throw Error(`Missing diorama texture: ${name}`);
      const rect = tileUV(tile),
        base = positions.length / 3;
      face.v.forEach((p, i) => {
        positions.push(x + p[0], y + p[1], z + p[2]);
        normals.push(...face.n);
        colors.push(face.shade, face.shade, face.shade);
        uvs.push(
          rect[0] + uvCorners[i][0] * rect[2],
          rect[1] + uvCorners[i][1] * rect[3],
        );
      });
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  const material = new THREE.MeshLambertMaterial({
    map: atlas,
    vertexColors: true,
    alphaTest: 0.5,
  });
  const mesh = new THREE.Mesh(geometry, material);
  return {
    mesh,
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
