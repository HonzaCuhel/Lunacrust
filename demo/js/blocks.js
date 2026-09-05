// Block registry. Ids are stored in the chunk arrays as Uint8, so id 0..255.
// `tex` is [top, side, bottom] and names a recipe in textures.js.
//
// Survival metadata lives here too: which tool speeds a block up, the tier that
// tool has to be before the block yields anything, and what it drops. Keeping it
// next to the block (rather than in a separate table) means a new block can never
// silently ship without a drop rule.

export const AIR = 0;

/** Tool tiers: 0 hands, 1 basic drill / wood, 2 stone, 3 iron, 4 crystal. */
export const TIER = { HAND: 0, BASIC: 1, STONE: 2, IRON: 3, CRYSTAL: 4 };

/** @type {Array<any>} */
export const BLOCKS = [];
export const BY_KEY = new Map();

function def(key, name, opts = {}) {
  const id = BLOCKS.length;
  const tex = opts.tex ?? [key, key, key];
  const block = {
    id,
    key,
    name,
    tex: tex.length === 1 ? [tex[0], tex[0], tex[0]] : tex.length === 2 ? [tex[0], tex[1], tex[0]] : tex,
    solid: opts.solid ?? true,      // stops the player
    opaque: opts.opaque ?? true,    // hides the neighbouring face
    liquid: opts.liquid ?? false,
    cutout: opts.cutout ?? false,   // alpha-tested (leaves, plants)
    light: opts.light ?? 0,         // 0..1 emissive boost
    hardness: opts.hardness ?? 1,
    sound: opts.sound ?? 'stone',

    // --- survival
    material: opts.material ?? 'rock',
    tool: opts.tool ?? null,        // tool type that mines it quickly
    tier: opts.tier ?? TIER.HAND,   // tier needed before it drops anything
    drop: opts.drop === undefined ? key : opts.drop,  // item key, null, or {item,min,max}
    interact: opts.interact ?? null, // 'crafting' | 'furnace' | 'oxygen'
    fuel: opts.fuel ?? 0,           // seconds of furnace burn when used as fuel
  };
  BLOCKS.push(block);
  BY_KEY.set(key, block);
  return id;
}

// air occupies id 0
def('air', 'Air', { solid: false, opaque: false, drop: null });

// -- common rock & soil ------------------------------------------------------
export const STONE = def('stone', 'Stone', { hardness: 2, tool: 'pickaxe', drop: 'cobble' });
export const COBBLE = def('cobble', 'Cobblestone', { hardness: 2, tool: 'pickaxe' });
export const DIRT = def('dirt', 'Dirt', { material: 'soil', tool: 'shovel' });
export const GRASS = def('grass', 'Grass Block', { tex: ['grass_top', 'grass_side', 'dirt'], sound: 'soft', material: 'soil', tool: 'shovel', drop: 'dirt' });
export const SAND = def('sand', 'Sand', { sound: 'soft', material: 'soil', tool: 'shovel' });
export const GRAVEL = def('gravel', 'Gravel', { sound: 'soft', material: 'soil', tool: 'shovel' });
export const SANDSTONE = def('sandstone', 'Sandstone', { tex: ['sandstone_top', 'sandstone', 'sandstone_top'], tool: 'pickaxe' });
export const BEDROCK = def('bedrock', 'Bedrock', { hardness: 999, drop: null });
export const OBSIDIAN = def('obsidian', 'Obsidian', { hardness: 6, tool: 'pickaxe', tier: TIER.IRON });
export const BASALT = def('basalt', 'Basalt', { tex: ['basalt_top', 'basalt', 'basalt_top'], hardness: 2, tool: 'pickaxe' });

// -- wood & flora ------------------------------------------------------------
export const LOG = def('log', 'Oak Log', { tex: ['log_top', 'log', 'log_top'], sound: 'wood', material: 'wood', tool: 'axe', fuel: 12 });
export const PLANKS = def('planks', 'Planks', { sound: 'wood', material: 'wood', tool: 'axe', fuel: 8 });
export const LEAVES = def('leaves', 'Leaves', { opaque: false, cutout: true, hardness: 0.4, sound: 'soft', material: 'foliage', drop: { item: 'algae', min: 0, max: 1 } });
export const ALIEN_LOG = def('alien_log', 'Xeno Stalk', { tex: ['alien_log_top', 'alien_log', 'alien_log_top'], sound: 'wood', material: 'wood', tool: 'axe', fuel: 12 });
export const ALIEN_LEAVES = def('alien_leaves', 'Xeno Canopy', { opaque: false, cutout: true, hardness: 0.4, sound: 'soft', material: 'foliage', drop: { item: 'spore_pod', min: 0, max: 2 } });
export const MOSS = def('moss', 'Tholin Moss', { sound: 'soft', material: 'foliage', tool: 'shovel', drop: { item: 'algae', min: 1, max: 2 } });

// -- liquids -----------------------------------------------------------------
export const WATER = def('water', 'Water', { solid: false, opaque: false, liquid: true, hardness: 100, sound: 'liquid', material: 'liquid', drop: null });
export const LAVA = def('lava', 'Lava', { solid: false, opaque: false, liquid: true, light: 0.9, hardness: 100, sound: 'liquid', material: 'liquid', drop: null });
export const METHANE = def('methane', 'Liquid Methane', { solid: false, opaque: false, liquid: true, hardness: 100, sound: 'liquid', material: 'liquid', drop: null });

// -- ice & snow --------------------------------------------------------------
export const ICE = def('ice', 'Ice', { opaque: false, hardness: 0.8, material: 'ice', tool: 'pickaxe' });
export const PACK_ICE = def('pack_ice', 'Packed Ice', { hardness: 1.2, material: 'ice', tool: 'pickaxe' });
export const SNOW = def('snow', 'Snow', { sound: 'soft', material: 'ice', tool: 'shovel' });
export const EUROPA_ICE = def('europa_ice', 'Europan Ice', { tex: ['europa_ice_top', 'europa_ice', 'europa_ice_top'], material: 'ice', tool: 'pickaxe' });
export const AMMONIA_ICE = def('ammonia_ice', 'Ammonia Ice', { hardness: 0.8, material: 'ice', tool: 'pickaxe' });

// -- ores & valuables --------------------------------------------------------
export const COAL_ORE = def('coal_ore', 'Coal Ore', { hardness: 3, tool: 'pickaxe', tier: TIER.BASIC, drop: { item: 'coal', min: 1, max: 2 } });
export const IRON_ORE = def('iron_ore', 'Iron Ore', { hardness: 3, tool: 'pickaxe', tier: TIER.STONE, drop: 'raw_iron' });
export const GOLD_ORE = def('gold_ore', 'Gold Ore', { hardness: 3, tool: 'pickaxe', tier: TIER.IRON, drop: 'raw_gold' });
export const CRYSTAL_ORE = def('crystal_ore', 'Void Crystal Ore', { hardness: 4, light: 0.25, tool: 'pickaxe', tier: TIER.IRON, drop: { item: 'crystal_shard', min: 1, max: 3 } });
export const ICE_ORE = def('ice_ore', 'Frozen Volatiles', { hardness: 2, tool: 'pickaxe', tier: TIER.BASIC, drop: { item: 'volatiles', min: 2, max: 4 } });
export const LUMINITE = def('luminite', 'Luminite', { light: 1, hardness: 1.5, tool: 'pickaxe', tier: TIER.BASIC });
export const CRYSTAL_BLOCK = def('crystal_block', 'Crystal Block', { opaque: false, light: 0.4, hardness: 2, tool: 'pickaxe', tier: TIER.STONE, drop: { item: 'crystal_shard', min: 2, max: 4 } });

// -- planetary surfaces ------------------------------------------------------
export const MARS_SAND = def('mars_sand', 'Martian Regolith', { sound: 'soft', material: 'soil', tool: 'shovel' });
export const MARS_ROCK = def('mars_rock', 'Martian Rock', { hardness: 2, tool: 'pickaxe' });
export const MARS_CLAY = def('mars_clay', 'Iron Clay', { material: 'soil', tool: 'shovel' });
export const MOON_DUST = def('moon_dust', 'Lunar Regolith', { sound: 'soft', material: 'soil', tool: 'shovel' });
export const MOON_ROCK = def('moon_rock', 'Anorthosite', { hardness: 2, tool: 'pickaxe' });
export const VENUS_CRUST = def('venus_crust', 'Venusian Crust', { hardness: 2, tool: 'pickaxe' });
export const SULFUR = def('sulfur', 'Sulfur', { sound: 'soft', material: 'soil', tool: 'shovel', fuel: 6 });
export const SULFUR_CRUST = def('sulfur_crust', 'Sulfur Crust', { hardness: 1.5, tool: 'pickaxe' });
export const TITAN_SAND = def('titan_sand', 'Tholin Dune Sand', { sound: 'soft', material: 'soil', tool: 'shovel' });
export const TITAN_ROCK = def('titan_rock', 'Water-Ice Bedrock', { hardness: 2, tool: 'pickaxe' });
export const CLOUD = def('cloud', 'Compressed Cloud', { hardness: 0.3, sound: 'soft', material: 'soil', tool: 'shovel' });
export const STORM_STONE = def('storm_stone', 'Storm Stone', { hardness: 2.5, tool: 'pickaxe' });
export const HELIUM_ICE = def('helium_ice', 'Metallic Hydrogen', { light: 0.35, hardness: 3, tool: 'pickaxe', tier: TIER.STONE });

// -- built blocks ------------------------------------------------------------
export const HULL = def('hull', 'Hull Plating', { hardness: 4, sound: 'metal', material: 'metal', tool: 'pickaxe', tier: TIER.STONE });
export const GLASS = def('glass', 'Reinforced Glass', { opaque: false, hardness: 1, sound: 'glass', material: 'glass', tool: 'pickaxe' });
export const LAMP = def('lamp', 'Habitat Lamp', { light: 1, hardness: 1, sound: 'glass', material: 'glass' });
export const SOLAR = def('solar', 'Solar Panel', { tex: ['solar', 'hull', 'hull'], hardness: 2, sound: 'metal', material: 'metal', tool: 'pickaxe', tier: TIER.BASIC });
export const BRICK = def('brick', 'Regolith Brick', { hardness: 2.5, tool: 'pickaxe' });

// -- survival stations -------------------------------------------------------
export const FABRICATOR = def('fabricator', 'Fabricator', {
  tex: ['fabricator_top', 'fabricator', 'planks'], hardness: 2.5, sound: 'wood',
  material: 'wood', tool: 'axe', interact: 'crafting', fuel: 10,
});
export const FURNACE = def('furnace', 'Smelter', {
  tex: ['furnace_top', 'furnace', 'furnace_top'], hardness: 3.5, sound: 'stone',
  material: 'rock', tool: 'pickaxe', tier: TIER.BASIC, interact: 'furnace',
});
export const FURNACE_LIT = def('furnace_lit', 'Smelter (lit)', {
  tex: ['furnace_top', 'furnace_lit', 'furnace_top'], hardness: 3.5, sound: 'stone', light: 0.75,
  material: 'rock', tool: 'pickaxe', tier: TIER.BASIC, interact: 'furnace', drop: 'furnace',
});
export const LIFE_SUPPORT = def('life_support', 'Life Support Unit', {
  tex: ['life_support_top', 'life_support', 'hull'], hardness: 3, sound: 'metal', light: 0.5,
  material: 'metal', tool: 'pickaxe', tier: TIER.STONE, interact: 'oxygen',
});

export const BLOCK_COUNT = BLOCKS.length;

export const isOpaque = (id) => BLOCKS[id].opaque;
export const isSolid = (id) => BLOCKS[id].solid;
export const isLiquid = (id) => BLOCKS[id].liquid;
export const blockOf = (key) => BY_KEY.get(key);

/** Blocks that open a screen instead of being placed on top of. */
export const isStation = (id) => !!BLOCKS[id].interact;
