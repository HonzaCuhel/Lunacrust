const worlds = {
  earth: {
    name: "Earth",
    type: "BLUE SKIES / A FAMILIAR BEGINNING",
    description:
      "One small landing kit. A whole horizon of possibility. This is where your signal begins.",
  },
  moon: {
    name: "Moon",
    type: "SILENT CRATERS / LIGHT FOOTSTEPS",
    description:
      "Leave a footprint, find a ridge and look back at the world you called home.",
  },
  mars: {
    name: "Mars",
    type: "RED CANYONS / STRANGE COMPANY",
    description:
      "Carve out a shelter beneath a rust-colored sky. You may not be the only thing moving.",
  },
  venus: {
    name: "Venus",
    type: "VOLCANIC GROUND / HEAVY SKIES",
    description:
      "A furnace of a world with a beauty all its own. Make every step count.",
  },
  europa: {
    name: "Europa",
    type: "ICE SPIRES / LOW GRAVITY",
    description:
      "Find your own quiet corner of a frozen ocean. There’s nothing small about the view.",
  },
  io: {
    name: "Io",
    type: "SULFUR FIELDS / JUPITER RISING",
    description:
      "Bright ground, restless horizons and a giant watching overhead.",
  },
  titan: {
    name: "Titan",
    type: "GOLDEN HAZE / METHANE SEAS",
    description:
      "Get lost beneath Saturn’s rings. A different kind of shoreline is waiting.",
  },
  jupiter: {
    name: "Jupiter",
    type: "FLOATING ISLANDS / A FICTIONAL FRONTIER",
    description:
      "An imagined world above the clouds. One last destination. One last signal.",
  },
};
const buttons = [...document.querySelectorAll("[data-world]")];
const picture = document.querySelector("#world-image");
let selection = 0;
async function choose(button) {
  const token = ++selection,
    id = button.dataset.world,
    world = worlds[id];
  const candidate = new Image();
  candidate.src = `assets/world-${id}.jpg`;
  try {
    await candidate.decode();
  } catch {
    return;
  }
  if (token !== selection) return;
  for (const b of buttons) b.setAttribute("aria-pressed", String(b === button));
  picture.src = candidate.src;
  picture.alt = `Actual ${world.name} landscape captured in Lunacrust`;
  document.querySelector("#world-name").textContent = world.name;
  document.querySelector("#world-type").textContent = world.type;
  document.querySelector("#world-description").textContent = world.description;
  document.querySelector("#world-number").textContent = String(
    buttons.indexOf(button) + 1,
  ).padStart(2, "0");
}
for (const button of buttons) {
  button.addEventListener("click", () => choose(button));
  button.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = buttons.indexOf(button),
      next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (i + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) %
              buttons.length;
    buttons[next].focus();
    choose(buttons[next]);
  });
}
// Sound starts only through native video controls, never on scroll or page load.
const film = document.querySelector("#trailer-video");
document.addEventListener("visibilitychange", () => {
  if (document.hidden && !film.paused) film.pause();
});
