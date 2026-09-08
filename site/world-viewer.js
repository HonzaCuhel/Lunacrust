// The promotional viewer reuses the exact game's fauna, palette and textures.
// It has no game simulation, storage, network session or save access.
import * as THREE from "./demo/vendor/three.module.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { PLANET_BY_ID } from "./demo/js/planets.js";
import { MobRender } from "./demo/js/mobrender.js";
import { MOB_TYPES } from "./demo/js/mobtypes.js";
import { buildAtlas } from "./demo/js/textures.js";
import { buildDiorama } from "./world-diorama.js";

export function createWorldViewer(stage, initialWorld) {
  const viewport = stage.querySelector(".model-viewport"),
    status = stage.querySelector(".model-status");
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  if (!gl) throw Error("WebGL2 is unavailable");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: gl,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x111d21, 0);
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-describedby", "model-help");
  viewport.append(canvas);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe9f3ff, 0x66705a, 2.4));
  const key = new THREE.DirectionalLight(0xfff2d4, 2.6);
  key.position.set(4, 8, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9edcff, 1.5);
  rim.position.set(-5, 3, -4);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = false;
  controls.enableZoom = false; // Ordinary page scrolling must not zoom the scene.
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI * 0.65;
  controls.autoRotateSpeed = 0.7;
  const atlasData = buildAtlas();
  const atlas = new THREE.DataTexture(
    atlasData.data,
    atlasData.width,
    atlasData.height,
  );
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.magFilter = THREE.NearestFilter;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let planet,
    subject = "both",
    preview = "model",
    model,
    diorama;
  let visible = false,
    motion = false,
    disposed = false,
    contextLost = false,
    frame = 0,
    last = 0,
    time = 0;
  const abort = new AbortController();
  const listen = (el, type, fn, extra = {}) =>
    el.addEventListener(type, fn, { signal: abort.signal, ...extra });
  const entities = [0, 1].map((kind) => ({
    kind,
    pos: { x: 0, y: 1, z: 0 },
    prev: { x: 0, y: 1, z: 0 },
    yaw: Math.PI + 0.25,
    prevYaw: Math.PI + 0.25,
    alive: true,
    gait: 0,
  }));
  const renderMobs = {
    alpha: 1,
    forEachLive(fn) {
      if (subject !== "resonator") fn(entities[0]);
      if (subject !== "skitter") fn(entities[1]);
    },
  };
  function canRender() {
    return (
      !disposed &&
      !contextLost &&
      visible &&
      preview === "model" &&
      !document.hidden
    );
  }
  function paint() {
    if (!canRender()) return;
    model.update(renderMobs, 0, camera.position);
    renderer.render(scene, camera);
  }
  function tick(now) {
    frame = 0;
    if (!canRender() || !motion) {
      last = 0;
      return;
    }
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    time += dt;
    entities[0].gait = time * 2.2;
    entities[1].gait = time * 1.4;
    controls.update(dt);
    paint();
    frame = requestAnimationFrame(tick);
  }
  function refresh() {
    paint();
    if (canRender() && motion && !frame) frame = requestAnimationFrame(tick);
    if ((!canRender() || !motion) && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
    }
  }
  function setMotion(on) {
    motion = on;
    controls.autoRotate = motion;
    const button = stage.querySelector('[data-camera="motion"]');
    button.setAttribute("aria-pressed", String(motion));
    button.textContent = motion ? "Pause rotation" : "Rotate";
    refresh();
  }
  function resetCamera() {
    const both = subject === "both";
    controls.target.set(0, both ? 1 : subject === "skitter" ? 1.5 : 2, 0);
    // A narrower view needs more vertical room for the same model width.
    const narrow = Math.max(1, 1.1 / Math.max(camera.aspect, 0.5));
    const scale = (both ? 1 : 0.46) * Math.min(narrow, 1.65);
    camera.position
      .copy(controls.target)
      .add(new THREE.Vector3(10, 7, 13).multiplyScalar(scale));
    controls.minDistance = both ? 7 : 3;
    controls.maxDistance = both ? 32 : 18;
    controls.update();
    refresh();
  }
  function resize() {
    const { width, height } = viewport.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    resetCamera();
  }
  function rebuild() {
    diorama?.dispose();
    model?.dispose();
    diorama = buildDiorama(planet, atlas, subject !== "both");
    scene.add(diorama.mesh);
    model = new MobRender(scene, planet);
    entities.forEach((entity, index) => {
      const pos = {
        x: subject === "both" ? (index === 0 ? -1.4 : 1) : 0,
        y: 1,
        z: subject === "both" ? 1.3 : 0,
      };
      Object.assign(entity.pos, pos);
      Object.assign(entity.prev, pos);
    });
    const name =
      subject === "both"
        ? "Diorama with Flux Skitter and Basalt Resonator"
        : MOB_TYPES[subject === "skitter" ? 0 : 1].name;
    canvas.setAttribute(
      "aria-label",
      `${planet.name}: ${name}. Interactive 3D model.`,
    );
    const info = stage.querySelector(".model-species");
    info.textContent =
      subject === "both"
        ? "Two species. Eight different worlds."
        : subject === "skitter"
          ? `${MOB_TYPES[0].health} health · Fast, volatile, six-legged.`
          : `${MOB_TYPES[1].health} health · Armored mineral tripod.`;
    stage.dataset.modelWorld = planet.id;
    stage.dataset.modelSubject = subject;
    resetCamera();
  }
  function setWorld(id) {
    planet = PLANET_BY_ID.get(id);
    if (!planet) throw Error(`Unknown model world: ${id}`);
    rim.color.set(planet.orb.glow);
    rebuild();
  }
  function setPreview(value) {
    preview = value;
    stage.dataset.preview = value;
    stage.querySelector(".model-tools").hidden = value !== "model";
    stage.querySelector(".model-caption").hidden = value !== "model";
    stage.querySelector(".model-species").hidden = value !== "model";
    stage
      .querySelectorAll("[data-preview]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.preview === value)),
      );
    if (value === "model") resize();
    refresh();
  }
  function zoom(factor) {
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(
      THREE.MathUtils.clamp(
        offset.length() * factor,
        controls.minDistance,
        controls.maxDistance,
      ),
    );
    camera.position.copy(controls.target).add(offset);
    controls.update();
    paint();
  }
  stage.querySelectorAll("[data-subject]").forEach((button) =>
    listen(button, "click", () => {
      subject = button.dataset.subject;
      stage
        .querySelectorAll("[data-subject]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      rebuild();
    }),
  );
  stage
    .querySelectorAll("[data-preview]")
    .forEach((button) =>
      listen(button, "click", () => setPreview(button.dataset.preview)),
    );
  stage.querySelectorAll("[data-camera]").forEach((button) =>
    listen(button, "click", () => {
      const action = button.dataset.camera;
      if (action === "motion") setMotion(!motion);
      if (action === "reset") {
        setMotion(false);
        resetCamera();
      }
      if (action === "zoom-in") zoom(0.8);
      if (action === "zoom-out") zoom(1.25);
    }),
  );
  listen(
    canvas,
    "pointerdown",
    () => {
      canvas.focus({ preventScroll: true });
      setMotion(false);
    },
    { capture: true },
  );
  listen(canvas, "focus", () => {
    controls.enableZoom = true;
  });
  listen(canvas, "blur", () => {
    controls.enableZoom = false;
  });
  listen(canvas, "keydown", (event) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "+",
        "=",
        "-",
        "Home",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    setMotion(false);
    if (event.key === "+" || event.key === "=") return zoom(0.8);
    if (event.key === "-") return zoom(1.25);
    if (event.key === "Home") return resetCamera();
    const spherical = new THREE.Spherical().setFromVector3(
      camera.position.clone().sub(controls.target),
    );
    if (event.key === "ArrowLeft") spherical.theta -= 0.16;
    if (event.key === "ArrowRight") spherical.theta += 0.16;
    if (event.key === "ArrowUp") spherical.phi -= 0.12;
    if (event.key === "ArrowDown") spherical.phi += 0.12;
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi,
      controls.minPolarAngle,
      controls.maxPolarAngle,
    );
    camera.position.setFromSpherical(spherical).add(controls.target);
    controls.update();
    paint();
  });
  controls.addEventListener("change", paint);
  listen(document, "visibilitychange", refresh);
  listen(reduced, "change", () => {
    if (reduced.matches) setMotion(false);
  });
  const observer = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    refresh();
  });
  const resizer = new ResizeObserver(resize);
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    resizer.disconnect();
    abort.abort();
    controls.dispose();
    model?.dispose();
    diorama?.dispose();
    atlas.dispose();
    renderer.dispose();
    canvas.remove();
  }
  listen(canvas, "webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
    setMotion(false);
    setPreview("photo");
    stage.dataset.viewerState = "lost";
    stage.querySelector('[data-preview="model"]').disabled = true;
    status.textContent =
      "3D paused because the graphics context was lost. Photographs are still available.";
  });
  listen(canvas, "webglcontextrestored", () => {
    contextLost = false;
    stage.dataset.viewerState = "ready";
    stage.querySelector('[data-preview="model"]').disabled = false;
    status.textContent =
      "3D is available again. Choose Interactive 3D to return.";
  });
  // Keep back/forward cache functional; permanent navigation releases GPU data.
  listen(window, "pagehide", (event) => {
    if (!event.persisted) dispose();
  });
  try {
    setWorld(initialWorld);
    stage.querySelector(".world-view-switch").hidden = false;
    stage.dataset.viewerState = "ready";
    status.textContent = "";
    setPreview("model");
    observer.observe(viewport);
    resizer.observe(viewport);
  } catch (error) {
    dispose();
    throw error;
  }
  return { setWorld, dispose };
}
