import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  CATCH,
  CHARACTERS,
  COLORS,
  FALL_MS,
  METEOR_COST,
  METEOR_R,
  R,
  SPEED,
  STAR_LIFE,
  STAR_POINTS,
  STUN_MS,
  SWARM_MS,
} from "./shared.js";
import { FRAMING, makeCharacter } from "./characters.js";

// The room server is the Cloudflare Worker in server/.
// Anywhere but the published site, it is `wrangler dev` on the machine serving the page.
const LOCAL = !/(^|\.)cashel\.dev$/.test(location.hostname);
const SERVER = LOCAL
  ? `ws://${location.hostname}:8791`
  : "wss://starfall.cashels-account.workers.dev";

const TAU = Math.PI * 2;
const PUBLIC_ROOM = "world";
const NAMES = [
  "Vega", "Lyra", "Orion", "Altair", "Rigel", "Nova", "Juno", "Atlas", "Mira", "Cygnus",
  "Deneb", "Carina", "Halley", "Sirius", "Callisto", "Io", "Ceres", "Pallas", "Tycho", "Kepler",
];
const SCALE = [293.66, 349.23, 392, 440, 523.25, 587.33, 698.46, 783.99, 880, 1046.5];
const SUN_CYCLE_MS = 300000;
const Y = new THREE.Vector3(0, 1, 0);
const COARSE = matchMedia("(pointer: coarse)").matches;

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const smooth = (t) => t * t * (3 - 2 * t);
const css = (index) => `#${COLORS[index].toString(16).padStart(6, "0")}`;

const canvas = $("c");
const players = new Map();
const stars = new Map();
const meteors = new Map();
const rings = [];
const keys = new Set();
const joy = { id: null, originX: 0, originY: 0, x: 0, y: 0 };

let ws = null;
let room = PUBLIC_ROOM;
let publicIndex = 1;
let myId = 0;
let me = null;
let phase = "play";
let endsAt = 0;
let clockOffset = 0;
let bestPing = Infinity;
let retries = 0;
let retryTimer = 0;
let asleep = false;
let leaving = false;
let sleepTimer = 0;
let lastSent = 0;
let streak = 0;
let lastCatch = 0;
let swarmAnnounced = false;
let toastTimer = 0;
let lastClock = "";
let blend = 0;
let shake = 0;

const serverNow = () => Date.now() + clockOffset;

/* Profile */

function loadProfile() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("starfall-profile")) || {};
  } catch (error) {
    // Private browsing: a new wanderer each visit.
  }
  return {
    name: typeof saved.name === "string" && saved.name ? saved.name.slice(0, 12) : pick(NAMES),
    c: Number.isInteger(saved.c) && saved.c >= 0 && saved.c < COLORS.length - 1 ? saved.c : Math.floor(rand(0, COLORS.length - 1)),
    // The plain wanderer is the robot Marvin's until someone asks for it.
    ch: Number.isInteger(saved.ch) && saved.ch >= 0 && saved.ch < CHARACTERS.length ? saved.ch : Math.floor(rand(1, CHARACTERS.length)),
    muted: saved.muted === true,
  };
}

const profile = loadProfile();

function saveProfile() {
  try {
    localStorage.setItem("starfall-profile", JSON.stringify(profile));
  } catch (error) {
    // Nothing to remember it in.
  }
}

/* Sound */

let audio = null;
let voices = null;

function wakeAudio() {
  if (profile.muted) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  if (!audio) {
    audio = new Context();
    voices = audio.createGain();
    voices.connect(audio.destination);
    // A long soft echo makes every note sound like it was played outdoors.
    const echo = audio.createDelay(1);
    const feedback = audio.createGain();
    const wet = audio.createGain();
    echo.delayTime.value = 0.31;
    feedback.gain.value = 0.42;
    wet.gain.value = 0.35;
    voices.connect(echo);
    echo.connect(feedback).connect(echo);
    echo.connect(wet).connect(audio.destination);
    for (const [frequency, level] of [[73.42, 0.03], [110.4, 0.018], [146.5, 0.012]]) {
      const drone = audio.createOscillator();
      const gain = audio.createGain();
      drone.frequency.value = frequency;
      gain.gain.value = level;
      drone.connect(gain).connect(voices);
      drone.start();
    }
  }
  if (audio.state === "suspended") audio.resume();
  voices.gain.value = 1;
}

function bell(frequency, delay = 0, volume = 0.12) {
  if (!audio || profile.muted || audio.state !== "running" || volume < 0.001) return;
  const start = audio.currentTime + delay;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.3);
  gain.connect(voices);
  for (const [multiple, level] of [[1, 1], [2.01, 0.3], [3.02, 0.08]]) {
    const voice = audio.createOscillator();
    const mix = audio.createGain();
    voice.frequency.value = frequency * multiple;
    mix.gain.value = level;
    voice.connect(mix).connect(gain);
    voice.start(start);
    voice.stop(start + 1.4);
  }
}

function chime(notes, gap = 0.1, volume = 0.1) {
  notes.forEach((note, index) => bell(SCALE[note], index * gap, volume));
}

function thud(volume) {
  if (!audio || profile.muted || audio.state !== "running" || volume <= 0.01) return;
  const start = audio.currentTime;
  const voice = audio.createOscillator();
  const gain = audio.createGain();
  voice.frequency.setValueAtTime(120, start);
  voice.frequency.exponentialRampToValueAtTime(36, start + 0.5);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
  voice.connect(gain).connect(voices);
  voice.start(start);
  voice.stop(start + 0.75);
}

/* Terrain */

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lattice(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  const mix = (a, b, t) => a + (b - a) * t;
  return mix(
    mix(
      mix(lattice(xi, yi, zi), lattice(xi + 1, yi, zi), u),
      mix(lattice(xi, yi + 1, zi), lattice(xi + 1, yi + 1, zi), u),
      v,
    ),
    mix(
      mix(lattice(xi, yi, zi + 1), lattice(xi + 1, yi, zi + 1), u),
      mix(lattice(xi, yi + 1, zi + 1), lattice(xi + 1, yi + 1, zi + 1), u),
      v,
    ),
    w,
  );
}

function fbm(x, y, z) {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let octave = 0; octave < 4; octave += 1) {
    sum += amplitude * (valueNoise(x * frequency + 17.3, y * frequency + 31.7, z * frequency + 47.1) * 2 - 1);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return sum / 0.9375;
}

const SEA = -0.2;
const relief = (v) => fbm(v.x * 1.3, v.y * 1.3, v.z * 1.3);
const grove = (v) => fbm(v.x * 0.9 + 40, v.y * 0.9 + 40, v.z * 0.9 + 40);

// Height of the land above the sea at a direction from the planet's centre.
function ground(v) {
  const n = relief(v);
  return n <= SEA ? 0 : (n - SEA) ** 1.2 * 1.9;
}

function surface(direction, lift = 0, out = new THREE.Vector3()) {
  return out.copy(direction).multiplyScalar(R + ground(direction) + lift);
}

function arcBetween(a, b) {
  return R * Math.acos(clamp(a.dot(b), -1, 1));
}

function tangents(direction) {
  const first = new THREE.Vector3().crossVectors(direction, Math.abs(direction.y) < 0.9 ? Y : new THREE.Vector3(1, 0, 0)).normalize();
  return [first, new THREE.Vector3().crossVectors(direction, first)];
}

/* Renderer */

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
} catch (error) {
  $("hint").textContent = "This browser can’t draw the planet (no WebGL).";
  $("hint").hidden = false;
  throw error;
}
let pixelRatio = Math.min(window.devicePixelRatio || 1, COARSE ? 1.5 : 2);
renderer.setPixelRatio(pixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1200);
const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: COARSE ? 0 : 4 });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.5, 1);
// One invalid pixel would be blurred by the bloom into a large black square, so they
// are dropped before the blur. Direct3D's min and max return the valid operand.
{
  const filter = bloom.materialHighPassFilter;
  const read = "vec4 texel = texture2D( tDiffuse, vUv );";
  if (filter.fragmentShader.includes(read)) {
    filter.fragmentShader = filter.fragmentShader.replace(read, `${read}\n texel = min( max( texel, vec4( 0.0 ) ), vec4( 64.0 ) );`);
    filter.needsUpdate = true;
  }
}
composer.addPass(bloom);
composer.addPass(new OutputPass());

const sunDirection = new THREE.Vector3(1, 0.2, 0).normalize();
const sun = new THREE.DirectionalLight(0xffd3a6, 3.3);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(COARSE ? 1024 : 2048);
sun.shadow.camera.left = -R - 3;
sun.shadow.camera.right = R + 3;
sun.shadow.camera.top = R + 3;
sun.shadow.camera.bottom = -R - 3;
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 70;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
const moonlight = new THREE.DirectionalLight(0x7f95ff, 1.1);
scene.add(sun, sun.target, moonlight, new THREE.AmbientLight(0x5c68c4, 1.3));

/* Sky */

const skyUniforms = {
  sun: { value: sunDirection },
  night: { value: new THREE.Color(0x05071a) },
  indigo: { value: new THREE.Color(0x1c1f55) },
  rose: { value: new THREE.Color(0xb5567e) },
  peach: { value: new THREE.Color(0xffb27a) },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 32, 20),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 sun, night, indigo, rose, peach;
      varying vec3 vDirection;
      void main() {
        float facing = dot(normalize(vDirection), sun);
        float t = facing * 0.5 + 0.5;
        vec3 color = mix(night, indigo, smoothstep(0.0, 0.6, t));
        color = mix(color, rose, smoothstep(0.55, 0.9, t) * 0.75);
        color = mix(color, peach, smoothstep(0.82, 1.0, t));
        color += peach * pow(max(facing, 0.0), 24.0) * 0.5;
        color += vec3(1.0, 0.86, 0.7) * smoothstep(0.9994, 0.9998, facing) * 5.0;
        gl_FragColor = vec4(color, 1.0);
      }`,
  }),
);
sky.renderOrder = -2;
scene.add(sky);

const starfieldUniforms = { sun: { value: sunDirection }, time: { value: 0 }, scale: { value: 1 } };
{
  const count = 1800;
  const positions = new Float32Array(count * 3);
  const traits = new Float32Array(count * 2);
  const random = seeded(5);
  for (let i = 0; i < count; i += 1) {
    const z = random() * 2 - 1;
    const angle = random() * TAU;
    const ring = Math.sqrt(1 - z * z);
    positions.set([ring * Math.cos(angle) * 500, ring * Math.sin(angle) * 500, z * 500], i * 3);
    traits.set([0.7 + random() ** 4 * 2.6, random() * TAU], i * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("trait", new THREE.BufferAttribute(traits, 2));
  const starfield = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: starfieldUniforms,
      vertexShader: `
        uniform vec3 sun;
        uniform float time, scale;
        attribute vec2 trait;
        varying float vGlow;
        void main() {
          float twinkle = 0.7 + 0.3 * sin(time * (0.6 + trait.y) + trait.y * 40.0);
          vGlow = twinkle * (1.0 - smoothstep(0.1, 0.85, dot(normalize(position), sun)));
          gl_PointSize = trait.x * scale;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vGlow;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(1.0, 0.96, 0.9) * 1.4, smoothstep(0.5, 0.1, d) * vGlow);
        }`,
    }),
  );
  starfield.renderOrder = -1;
  starfield.frustumCulled = false;
  scene.add(starfield);
}

const moon = new THREE.Group();
moon.add(
  new THREE.Mesh(
    new THREE.IcosahedronGeometry(15, 2),
    new THREE.MeshStandardMaterial({ color: 0xcfc6ea, flatShading: true, roughness: 1 }),
  ),
);
{
  const band = new THREE.Mesh(
    new THREE.RingGeometry(21, 29, 72),
    new THREE.MeshBasicMaterial({ color: 0xf0d9c6, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }),
  );
  band.rotation.set(1.25, 0.3, 0);
  moon.add(band);
}
moon.position.set(-120, 62, -170);
scene.add(moon);

const airUniforms = {
  sun: { value: sunDirection },
  day: { value: new THREE.Color(0xffa98a) },
  dusk: { value: new THREE.Color(0x6f7cff) },
};
scene.add(
  new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.22, 48, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: airUniforms,
      vertexShader: `
        varying vec3 vNormal, vView, vWorld;
        void main() {
          vec4 eye = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-eye.xyz);
          vWorld = normalize(position);
          gl_Position = projectionMatrix * eye;
        }`,
      fragmentShader: `
        uniform vec3 sun, day, dusk;
        varying vec3 vNormal, vView, vWorld;
        void main() {
          float rim = pow(clamp(-dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.6);
          float lit = smoothstep(-0.5, 0.7, dot(vWorld, sun));
          gl_FragColor = vec4(mix(dusk * 0.55, day, lit) * rim * 1.5, 1.0);
        }`,
    }),
  ),
);

/* Planet */

const colliders = [];

function tinted(geometry, hex) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const color = new THREE.Color(hex);
  const count = flat.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) colors.set([color.r, color.g, color.b], i * 3);
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return flat;
}

function buildPlanet() {
  const random = seeded(23);
  const geometry = new THREE.IcosahedronGeometry(1, 22);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const middle = new THREE.Vector3();
  const color = new THREE.Color();
  const shallow = new THREE.Color(0x4aa9b3);
  const deep = new THREE.Color(0x1f4f78);
  const sand = new THREE.Color(0xe2cda2);
  const meadow = new THREE.Color(0x5b987f);
  const upland = new THREE.Color(0xa7c79b);
  const stone = new THREE.Color(0xd8cdb8);
  for (let face = 0; face < position.count; face += 3) {
    a.fromBufferAttribute(position, face).normalize();
    b.fromBufferAttribute(position, face + 1).normalize();
    c.fromBufferAttribute(position, face + 2).normalize();
    middle.copy(a).add(b).add(c).normalize();
    const n = relief(middle);
    const height = ground(middle);
    if (n <= SEA) color.copy(shallow).lerp(deep, clamp((SEA - n) * 4.5, 0, 1));
    else if (n - SEA < 0.03) color.copy(sand);
    else if (height < 0.95) color.copy(meadow).lerp(upland, smooth(clamp(height / 0.9, 0, 1)));
    else color.copy(upland).lerp(stone, clamp((height - 0.95) * 3, 0, 1));
    color.multiplyScalar(0.93 + random() * 0.14);
    for (const [index, corner] of [[face, a], [face + 1, b], [face + 2, c]]) {
      surface(corner, 0, corner);
      position.setXYZ(index, corner.x, corner.y, corner.z);
      colors.set([color.r, color.g, color.b], index * 3);
    }
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const planet = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 }),
  );
  planet.receiveShadow = true;
  scene.add(planet);

  const somewhere = (out) => {
    const z = random() * 2 - 1;
    const angle = random() * TAU;
    const ring = Math.sqrt(1 - z * z);
    return out.set(ring * Math.cos(angle), z, ring * Math.sin(angle));
  };
  const free = (direction, room) => colliders.every((other) => arcBetween(direction, other.d) > room + other.r);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const spot = new THREE.Vector3();
  const tint = new THREE.Color();

  // Scatters one kind of thing over the land, each standing upright on the ground.
  const scatter = (geometry, material, count, tries, accept, size, radius, tinting) => {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    let placed = 0;
    for (let attempt = 0; attempt < tries && placed < count; attempt += 1) {
      const direction = somewhere(new THREE.Vector3());
      const n = relief(direction);
      if (n < SEA + 0.05 || !accept(direction, n)) continue;
      const grow = size[0] + random() * (size[1] - size[0]);
      if (!free(direction, radius * grow + 0.12)) continue;
      quaternion.setFromUnitVectors(Y, direction).multiply(spin.setFromAxisAngle(Y, random() * TAU));
      scale.set(grow * (0.85 + random() * 0.3), grow, grow * (0.85 + random() * 0.3));
      matrix.compose(surface(direction, -0.06, spot), quaternion, scale);
      mesh.setMatrixAt(placed, matrix);
      mesh.setColorAt(placed, tint.setScalar(tinting[0] + random() * (tinting[1] - tinting[0])));
      colliders.push({ d: direction, r: radius * grow });
      placed += 1;
    }
    mesh.count = placed;
    scene.add(mesh);
  };
  const matte = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });

  const lift = (geometry, y) => geometry.translate(0, y, 0);
  const pine = mergeGeometries([
    tinted(lift(new THREE.CylinderGeometry(0.06, 0.09, 0.4, 5), 0.2), 0x4a382d),
    tinted(lift(new THREE.ConeGeometry(0.44, 0.75, 6), 0.7), 0x1d4c4b),
    tinted(lift(new THREE.ConeGeometry(0.34, 0.65, 6), 1.08), 0x24595a),
    tinted(lift(new THREE.ConeGeometry(0.22, 0.55, 6), 1.44), 0x2e6b66),
  ]);
  scatter(pine, matte, 120, 2600, (direction, n) => grove(direction) > 0.04 && n < SEA + 0.42, [0.7, 1.25], 0.3, [0.8, 1.15]);

  const blossom = mergeGeometries([
    tinted(lift(new THREE.CylinderGeometry(0.05, 0.09, 0.7, 5), 0.35), 0x4a382d),
    tinted(new THREE.IcosahedronGeometry(0.42, 0).translate(0, 0.95, 0), 0xf08f7d),
    tinted(new THREE.IcosahedronGeometry(0.3, 0).translate(0.3, 0.78, 0.1), 0xf6b3a0),
    tinted(new THREE.IcosahedronGeometry(0.26, 0).translate(-0.26, 0.82, -0.14), 0xe97765),
  ]);
  scatter(blossom, matte, 18, 900, (direction) => grove(direction) < 0, [0.8, 1.2], 0.3, [0.9, 1.1]);

  const rock = tinted(new THREE.DodecahedronGeometry(0.4, 0).translate(0, 0.16, 0), 0x8d91ab);
  scatter(rock, matte, 44, 900, () => true, [0.35, 1.1], 0.36, [0.75, 1.15]);

  // A ring of standing stones on high ground.
  const stoneGeometry = tinted(new THREE.BoxGeometry(0.34, 1.5, 0.22).translate(0, 0.7, 0), 0xcdd0e2);
  const stones = new THREE.InstancedMesh(stoneGeometry, matte, 7);
  stones.castShadow = true;
  const hill = new THREE.Vector3();
  let best = -1;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const direction = somewhere(new THREE.Vector3());
    const n = relief(direction);
    if (n > best && n < SEA + 0.4 && free(direction, 2.6)) {
      best = n;
      hill.copy(direction);
    }
  }
  const [east, north] = tangents(hill);
  for (let i = 0; i < 7; i += 1) {
    const angle = (i / 7) * TAU;
    const direction = hill.clone()
      .addScaledVector(east, Math.cos(angle) * 0.17)
      .addScaledVector(north, Math.sin(angle) * 0.17)
      .normalize();
    quaternion.setFromUnitVectors(Y, direction).multiply(spin.setFromAxisAngle(Y, random() * TAU));
    scale.set(1, 0.7 + random() * 0.5, 1);
    matrix.compose(surface(direction, -0.1, spot), quaternion, scale);
    stones.setMatrixAt(i, matrix);
    stones.setColorAt(i, tint.setScalar(0.85 + random() * 0.2));
    colliders.push({ d: direction, r: 0.3 });
  }
  scene.add(stones);

  // And a lighthouse somewhere by the water.
  const shore = new THREE.Vector3(0, 1, 0);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const direction = somewhere(new THREE.Vector3());
    const n = relief(direction);
    if (n > SEA + 0.04 && n < SEA + 0.1 && free(direction, 1.4)) {
      shore.copy(direction);
      break;
    }
  }
  const tower = new THREE.Group();
  const body = new THREE.Mesh(
    mergeGeometries([
      tinted(lift(new THREE.CylinderGeometry(0.3, 0.48, 2.3, 8), 1.15), 0xf1ebe0),
      tinted(lift(new THREE.CylinderGeometry(0.36, 0.39, 0.34, 8), 1.5), 0xd9654a),
      tinted(lift(new THREE.CylinderGeometry(0.4, 0.4, 0.08, 8), 2.32), 0x3b3550),
      tinted(lift(new THREE.ConeGeometry(0.36, 0.42, 8), 2.95), 0xd9654a),
    ]),
    matte,
  );
  body.castShadow = true;
  const lamp = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.38, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.78, 0.45).multiplyScalar(4) }),
  );
  lamp.position.y = 2.55;
  tower.add(body, lamp);
  tower.quaternion.setFromUnitVectors(Y, shore);
  surface(shore, -0.08, tower.position);
  scene.add(tower);
  colliders.push({ d: shore, r: 0.6 });
}

buildPlanet();

/* Wanderers */

const markGeometry = new THREE.RingGeometry(0.5, 0.54, 40).rotateX(-Math.PI / 2);
const TRAIL = 30;
// The game's bloom already spreads light, so the figures bring less of their own.
const IN_GAME = { gain: 0.8, halo: 0.3 };

function makeWanderer(data) {
  const color = new THREE.Color(COLORS[data.c] ?? COLORS[0]);
  const figure = new THREE.Group();
  const character = makeCharacter(data.ch, IN_GAME);
  character.paint(color);
  figure.add(character.root);
  scene.add(figure);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL * 6), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TRAIL * 6), 3));
  const index = [];
  for (let i = 0; i < TRAIL - 1; i += 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  geometry.setIndex(index);
  const trail = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  trail.frustumCulled = false;
  scene.add(trail);

  const direction = new THREE.Vector3(...data.d).normalize();
  const tag = document.createElement("div");
  tag.className = "tag";
  tag.textContent = data.name;
  $("tags").append(tag);
  return {
    id: data.id,
    name: data.name,
    c: data.c,
    ch: data.ch,
    bot: Boolean(data.bot),
    score: data.score || 0,
    dir: direction,
    target: direction.clone(),
    facing: tangents(direction)[0],
    previous: direction.clone(),
    move: 0,
    stride: 0,
    stunnedUntil: 0,
    cheer: 0,
    depth: 0.03,
    wake: 0,
    color,
    figure,
    character,
    trail,
    samples: [],
    tag,
  };
}

// A robot hands its figure to a person who asked for it, and takes another.
function redress(wanderer, ch) {
  wanderer.figure.remove(wanderer.character.root);
  wanderer.character.dispose();
  wanderer.ch = ch;
  wanderer.character = makeCharacter(ch, IN_GAME);
  wanderer.character.paint(wanderer.color);
  wanderer.figure.add(wanderer.character.root);
}

function removeWanderer(wanderer) {
  scene.remove(wanderer.figure, wanderer.trail);
  wanderer.trail.geometry.dispose();
  wanderer.trail.material.dispose();
  wanderer.character.dispose();
  wanderer.tag.remove();
}

function clearWanderers() {
  for (const wanderer of players.values()) removeWanderer(wanderer);
  players.clear();
  me = null;
  scene.add(myLight);
}

const myMark = new THREE.Mesh(
  markGeometry,
  new THREE.MeshBasicMaterial({ color: 0xf4ecdf, transparent: true, opacity: 0.55, depthWrite: false }),
);
myMark.position.y = 0.09;
const myLight = new THREE.PointLight(0xffc890, 1.2, 7, 2);
myLight.position.y = 1.1;
// It waits in the scene (buried in the planet) so that joining doesn't add a light,
// which would make every lit shader compile again mid-game.
scene.add(myLight);

const WAKE = new THREE.Color(0.22, 0.36, 0.4);
const basis = new THREE.Matrix4();
const scratch = new THREE.Vector3();
const scratch2 = new THREE.Vector3();
const scratch3 = new THREE.Vector3();
const pose = { t: 0, dt: 0, move: 0, stride: 0, cheer: 0, hop: 0, flash: 0 };

function animateWanderer(wanderer, dt, t, now) {
  if (wanderer !== me) {
    wanderer.dir.lerp(wanderer.target, 1 - Math.exp(-dt * 12)).normalize();
  }
  const step = scratch.copy(wanderer.dir).sub(wanderer.previous);
  const speed = (step.length() * R) / dt;
  const moving = speed > 0.4;
  if (moving && wanderer !== me) {
    step.addScaledVector(wanderer.dir, -step.dot(wanderer.dir)).normalize();
    wanderer.facing.lerp(step, 1 - Math.exp(-dt * 10));
  }
  wanderer.previous.copy(wanderer.dir);
  wanderer.move += ((moving ? 1 : 0) - wanderer.move) * Math.min(1, dt * 9);
  if (moving) wanderer.stride += dt * 11;
  wanderer.cheer = Math.max(0, wanderer.cheer - dt * 2.4);

  const up = wanderer.dir;
  const forward = scratch2.copy(wanderer.facing).addScaledVector(up, -wanderer.facing.dot(up));
  if (forward.lengthSq() < 1e-6) forward.copy(tangents(up)[0]);
  forward.normalize();
  wanderer.facing.copy(forward);
  basis.makeBasis(scratch3.crossVectors(up, forward), up, forward);
  wanderer.figure.quaternion.setFromRotationMatrix(basis);
  // In the shallows they wade, and leave rings on the water as they go.
  const wading = relief(up) <= SEA;
  wanderer.depth += ((wading ? 0.26 : 0.03) - wanderer.depth) * Math.min(1, dt * 8);
  surface(up, -wanderer.depth, wanderer.figure.position);
  if (wading && moving && t - wanderer.wake > 0.6) {
    wanderer.wake = t;
    ripple(up, WAKE, 0.25, 0.55, 0.6);
  }

  const stunned = now < wanderer.stunnedUntil;
  pose.t = t + wanderer.id * 1.7;
  pose.dt = dt;
  pose.move = wanderer.move;
  pose.stride = wanderer.stride;
  pose.cheer = wanderer.cheer;
  pose.hop = wanderer.cheer * Math.sin(wanderer.cheer * Math.PI);
  pose.flash = stunned ? 0.75 + 0.6 * Math.sin(t * 40) : 0;
  wanderer.character.update(pose);
  wanderer.character.root.rotation.y = stunned ? t * 14 : 0;

  // The ribbon they leave behind grows with every star they carry.
  const samples = wanderer.samples;
  const waist = surface(up, 0.42, scratch);
  if (!samples.length || samples[0].distanceTo(waist) > 0.22) {
    samples.unshift(waist.clone());
    if (samples.length > TRAIL) samples.pop();
  } else {
    samples[0].copy(waist);
  }
  const length = Math.min(samples.length, 6 + wanderer.score, TRAIL);
  const positions = wanderer.trail.geometry.attributes.position;
  const colors = wanderer.trail.geometry.attributes.color;
  for (let i = 0; i < TRAIL; i += 1) {
    const at = samples[Math.min(i, samples.length - 1)];
    const fade = i < length ? 1 - i / length : 0;
    const ahead = samples[Math.max(0, Math.min(i, samples.length - 1) - 1)];
    const behind = samples[Math.min(samples.length - 1, i + 1)];
    const side = scratch2.copy(ahead).sub(behind).cross(at).normalize().multiplyScalar(0.13 * fade * fade);
    positions.setXYZ(i * 2, at.x + side.x, at.y + side.y, at.z + side.z);
    positions.setXYZ(i * 2 + 1, at.x - side.x, at.y - side.y, at.z - side.z);
    const glow = fade * fade * 1.5;
    colors.setXYZ(i * 2, wanderer.color.r * glow, wanderer.color.g * glow, wanderer.color.b * glow);
    colors.setXYZ(i * 2 + 1, wanderer.color.r * glow, wanderer.color.g * glow, wanderer.color.b * glow);
  }
  positions.needsUpdate = true;
  colors.needsUpdate = true;
}

/* Sparks, rings and other brief things */

const SPARKS = 600;
const sparkPosition = new Float32Array(SPARKS * 3);
const sparkColor = new Float32Array(SPARKS * 3);
const sparkBase = new Float32Array(SPARKS * 3);
const sparkVelocity = new Float32Array(SPARKS * 3);
const sparkLife = new Float32Array(SPARKS);
const sparkSpan = new Float32Array(SPARKS);
let sparkNext = 0;
const sparkGeometry = new THREE.BufferGeometry();
sparkGeometry.setAttribute("position", new THREE.BufferAttribute(sparkPosition, 3));
sparkGeometry.setAttribute("color", new THREE.BufferAttribute(sparkColor, 3));
{
  const dot = document.createElement("canvas");
  dot.width = 64;
  dot.height = 64;
  const c = dot.getContext("2d");
  const glow = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.35, "rgba(255,255,255,0.4)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = glow;
  c.fillRect(0, 0, 64, 64);
  const sparks = new THREE.Points(
    sparkGeometry,
    new THREE.PointsMaterial({
      size: 0.34,
      map: new THREE.CanvasTexture(dot),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sparks.frustumCulled = false;
  scene.add(sparks);
}

function burst(origin, normal, color, count, speed) {
  for (let n = 0; n < count; n += 1) {
    const i = sparkNext;
    sparkNext = (sparkNext + 1) % SPARKS;
    const push = rand(0.3, 1) * speed;
    sparkPosition.set([origin.x, origin.y, origin.z], i * 3);
    sparkVelocity.set(
      [
        normal.x * push + rand(-1, 1) * speed * 0.7,
        normal.y * push + rand(-1, 1) * speed * 0.7,
        normal.z * push + rand(-1, 1) * speed * 0.7,
      ],
      i * 3,
    );
    sparkBase.set([color.r, color.g, color.b], i * 3);
    sparkSpan[i] = rand(0.5, 1.1);
    sparkLife[i] = sparkSpan[i];
  }
}

function updateSparks(dt) {
  const drag = 1 - Math.min(1, dt * 1.8);
  for (let i = 0; i < SPARKS; i += 1) {
    if (sparkLife[i] <= 0) continue;
    sparkLife[i] -= dt;
    const fade = Math.max(0, sparkLife[i] / sparkSpan[i]);
    for (let axis = 0; axis < 3; axis += 1) {
      const k = i * 3 + axis;
      sparkVelocity[k] *= drag;
      sparkPosition[k] += sparkVelocity[k] * dt;
      sparkColor[k] = sparkBase[k] * fade * fade * 2;
    }
  }
  sparkGeometry.attributes.position.needsUpdate = true;
  sparkGeometry.attributes.color.needsUpdate = true;
}

const ringGeometry = new THREE.RingGeometry(0.965, 1, 72).rotateX(-Math.PI / 2);

// A circle of light spreading over the ground.
function ripple(direction, color, from, to, life) {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(ringGeometry, material);
  mesh.quaternion.setFromUnitVectors(Y, direction);
  scene.add(mesh);
  rings.push({ mesh, material, age: 0, life, from, to, around: direction.clone(), level: ground(direction) + 0.22 });
}

function updateRings(dt) {
  for (let i = rings.length - 1; i >= 0; i -= 1) {
    const ring = rings[i];
    ring.age += dt;
    const t = ring.age / ring.life;
    if (t >= 1) {
      scene.remove(ring.mesh);
      ring.material.dispose();
      rings.splice(i, 1);
      continue;
    }
    const size = ring.from + (ring.to - ring.from) * (1 - (1 - t) ** 3);
    ring.mesh.scale.setScalar(size);
    // A wider circle sits lower, so that it stays on the curve of the planet.
    if (ring.around) ring.mesh.position.copy(ring.around).multiplyScalar(Math.sqrt(R * R - size * size) + ring.level);
    ring.material.opacity = (ring.around ? 0.7 : 1) * (1 - t) ** 1.5;
  }
}

/* Stars */

const STAR_TINT = [new THREE.Color(0.86, 0.94, 1), new THREE.Color(1, 0.72, 0.34)];
const crystalGeometry = new THREE.OctahedronGeometry(0.2, 0).scale(1, 1.7, 1);
const beamGeometry = new THREE.CylinderGeometry(0.01, 0.045, 9, 6, 1, true).translate(0, 4.5, 0);
const streakGeometry = new THREE.CylinderGeometry(0.004, 0.05, 4.5, 5).translate(0, 2.25, 0);
const haloGeometry = new THREE.CircleGeometry(0.75, 28).rotateX(-Math.PI / 2);
const haloTexture = (() => {
  const dot = document.createElement("canvas");
  dot.width = 128;
  dot.height = 128;
  const c = dot.getContext("2d");
  const glow = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  glow.addColorStop(0, "rgba(255,255,255,0.9)");
  glow.addColorStop(0.4, "rgba(255,255,255,0.25)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = glow;
  c.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(dot);
})();
const starMaterials = STAR_TINT.map((tint) => ({
  crystal: new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(2.2) }),
  streak: new THREE.MeshBasicMaterial({
    color: tint.clone().multiplyScalar(1.5),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
  halo: new THREE.MeshBasicMaterial({
    color: tint,
    map: haloTexture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
  beam: new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { tint: { value: tint } },
    vertexShader: `
      varying float vHeight;
      void main() {
        vHeight = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 tint;
      varying float vHeight;
      void main() {
        // Clamped: with antialiasing vHeight can stray past 1 at an edge, and a negative
        // base makes pow() return an invalid pixel on Windows.
        gl_FragColor = vec4(tint, pow(clamp(1.0 - vHeight, 0.0, 1.0), 1.8) * 0.4);
      }`,
  }),
}));

function addStar(data, now) {
  const direction = new THREE.Vector3(...data.d).normalize();
  const materials = starMaterials[data.k];
  const group = new THREE.Group();
  const crystal = new THREE.Mesh(crystalGeometry, materials.crystal);
  const beam = new THREE.Mesh(beamGeometry, materials.beam);
  const halo = new THREE.Mesh(haloGeometry, materials.halo);
  const streak = new THREE.Mesh(streakGeometry, materials.streak);
  halo.position.y = 0.14;
  if (data.k) crystal.scale.setScalar(1.35);
  group.add(crystal, beam, halo, streak);
  group.quaternion.setFromUnitVectors(Y, direction);
  surface(direction, 0, group.position);
  scene.add(group);
  const landed = now - data.t0 > FALL_MS + 300;
  stars.set(data.id, { id: data.id, k: data.k, t0: data.t0, dir: direction, group, crystal, beam, halo, streak, landed, claimed: 0 });
}

function removeStar(star) {
  scene.remove(star.group);
  stars.delete(star.id);
}

function clearStars() {
  for (const star of [...stars.values()]) removeStar(star);
}

function updateStars(now, t) {
  for (const star of stars.values()) {
    const age = now - star.t0;
    const left = STAR_LIFE[star.k] - age;
    if (left <= 0) {
      removeStar(star);
      continue;
    }
    const falling = age < FALL_MS;
    star.streak.visible = falling;
    star.crystal.visible = !falling;
    star.beam.visible = !falling;
    if (falling) {
      const f = clamp(age / FALL_MS, 0, 1);
      star.streak.position.y = 0.8 + (1 - f * f) * 30;
      star.halo.scale.setScalar(0.2 + f * 0.8);
      continue;
    }
    if (!star.landed) {
      star.landed = true;
      ripple(star.dir, STAR_TINT[star.k].clone().multiplyScalar(1.6), 0.2, 1.7, 0.7);
      burst(surface(star.dir, 0.4, scratch), star.dir, STAR_TINT[star.k], 8, 2.2);
      if (me) bell(SCALE[star.k ? 7 : 5] * 2, 0, 0.012 * clamp(1.4 - arcBetween(me.dir, star.dir) / 12, 0, 1));
    }
    const fade = Math.min(1, left / 1800);
    const size = (star.k ? 1.35 : 1) * fade;
    star.crystal.scale.setScalar(Math.max(0.001, size));
    star.crystal.position.y = 0.85 + Math.sin(t * 2 + star.id) * 0.1;
    star.crystal.rotation.y = t * 1.6 + star.id;
    star.beam.scale.set(fade, fade, fade);
    star.halo.scale.setScalar((1 + Math.sin(t * 3 + star.id) * 0.12) * fade);
  }
}

/* Meteors */

const METEOR_TINT = new THREE.Color(1, 0.3, 0.16);
const meteorGeometry = new THREE.CylinderGeometry(0.01, 0.3, 9, 6).translate(0, 4.5, 0);
const meteorMaterial = new THREE.MeshBasicMaterial({
  color: METEOR_TINT.clone().multiplyScalar(3),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const flashGeometry = new THREE.IcosahedronGeometry(1, 2);

// A flat ring laid over the hills, so a warning hugs the ground it threatens.
function draped(direction, inner, outer) {
  const [east, north] = tangents(direction);
  const around = 48;
  const across = inner > 0 ? 1 : 5;
  const positions = [];
  const index = [];
  const point = new THREE.Vector3();
  for (let ring = 0; ring <= across; ring += 1) {
    const reach = Math.tan((inner + ((outer - inner) * ring) / across) / R);
    for (let step = 0; step <= around; step += 1) {
      const angle = (step / around) * TAU;
      point.copy(direction)
        .addScaledVector(east, Math.cos(angle) * reach)
        .addScaledVector(north, Math.sin(angle) * reach)
        .normalize();
      surface(point, 0.12, point);
      positions.push(point.x, point.y, point.z);
      if (ring === across || step === around) continue;
      const a = ring * (around + 1) + step;
      index.push(a, a + 1, a + around + 1, a + 1, a + around + 2, a + around + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

function addMeteor(data) {
  const direction = new THREE.Vector3(...data.d).normalize();
  const fill = new THREE.Mesh(
    draped(direction, 0, METEOR_R),
    new THREE.MeshBasicMaterial({
      color: METEOR_TINT,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const edge = new THREE.Mesh(
    draped(direction, METEOR_R - 0.09, METEOR_R),
    new THREE.MeshBasicMaterial({
      color: METEOR_TINT.clone().multiplyScalar(2.4),
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const streak = new THREE.Mesh(meteorGeometry, meteorMaterial);
  streak.quaternion.setFromUnitVectors(Y, direction);
  streak.visible = false;
  scene.add(fill, edge, streak);
  meteors.set(data.id, { id: data.id, at: data.at, dir: direction, fill, edge, streak, seen: serverNow() });
}

function removeMeteor(meteor) {
  scene.remove(meteor.fill, meteor.edge, meteor.streak);
  for (const mesh of [meteor.fill, meteor.edge]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  meteors.delete(meteor.id);
}

function clearMeteors() {
  for (const meteor of [...meteors.values()]) removeMeteor(meteor);
}

function impact(meteor) {
  const ground0 = surface(meteor.dir, 0.3);
  const material = new THREE.MeshBasicMaterial({
    color: METEOR_TINT.clone().multiplyScalar(3),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flash = new THREE.Mesh(flashGeometry, material);
  flash.position.copy(ground0);
  scene.add(flash);
  rings.push({ mesh: flash, material, age: 0, life: 0.55, from: 0.3, to: METEOR_R * 0.95 });
  ripple(meteor.dir, METEOR_TINT.clone().multiplyScalar(2.5), 0.4, METEOR_R * 1.7, 0.9);
  burst(ground0, meteor.dir, new THREE.Color(1, 0.5, 0.25), 46, 7);
  if (!me) return;
  const closeness = clamp(1 - arcBetween(me.dir, meteor.dir) / 9, 0, 1);
  shake = Math.max(shake, closeness * 0.55);
  thud(0.32 * closeness);
}

function updateMeteors(now, t) {
  for (const meteor of meteors.values()) {
    const left = meteor.at - now;
    if (left <= 0) {
      impact(meteor);
      removeMeteor(meteor);
      continue;
    }
    const progress = clamp((now - meteor.seen) / Math.max(1, meteor.at - meteor.seen), 0, 1);
    meteor.fill.material.opacity = 0.05 + progress * 0.16 + Math.sin(t * (6 + progress * 16)) * 0.03;
    meteor.edge.material.opacity = 0.6 + 0.4 * Math.sin(t * (6 + progress * 16));
    meteor.streak.visible = left < 650;
    if (meteor.streak.visible) surface(meteor.dir, (left / 650) ** 1.5 * 60, meteor.streak.position);
  }
}

/* Camera */

const cameraForward = new THREE.Vector3(0, 0, 1);
const orbitPosition = new THREE.Vector3();
const followPosition = new THREE.Vector3();
const followLook = new THREE.Vector3();
const lookAt = new THREE.Vector3();
const cameraUp = new THREE.Vector3();

function placeCamera(dt, t) {
  const tall = innerHeight > innerWidth;
  blend += ((me ? 1 : 0) - blend) * Math.min(1, dt * 1.6);
  if (me && blend > 0.997) blend = 1;
  const b = smooth(clamp(blend, 0, 1));

  // From afar the camera circles, keeping the sunset edge of the planet in view.
  const azimuth = Math.atan2(sunDirection.z, sunDirection.x) + 1.05 + t * 0.03;
  const distance = tall ? 56 : 39;
  orbitPosition.set(Math.cos(azimuth) * distance, distance * 0.22, Math.sin(azimuth) * distance);
  camera.fov = tall ? 56 : 46;

  if (me) {
    const feet = surface(me.dir, 0, scratch);
    const height = tall ? 13 : 8.4;
    const back = tall ? 8.5 : 7.4;
    followPosition.copy(feet).addScaledVector(me.dir, height).addScaledVector(cameraForward, -back);
    followLook.copy(feet).addScaledVector(me.dir, 0.9).addScaledVector(cameraForward, tall ? 1.6 : 1);
    camera.position.lerpVectors(orbitPosition, followPosition, b);
    lookAt.set(0, 0, 0).lerp(followLook, b);
    cameraUp.copy(Y).lerp(me.dir, b).normalize();
  } else {
    camera.position.copy(orbitPosition);
    lookAt.set(0, 0, 0);
    cameraUp.copy(Y);
  }
  if (shake > 0.001) {
    camera.position.x += rand(-1, 1) * shake;
    camera.position.y += rand(-1, 1) * shake;
    camera.position.z += rand(-1, 1) * shake;
    shake *= Math.exp(-dt * 6);
  }
  camera.up.copy(cameraUp);
  camera.lookAt(lookAt);

  // On the title screen the planet steps aside to make room for the words.
  const aside = 1 - b;
  if (aside > 0.002) {
    camera.setViewOffset(innerWidth, innerHeight, tall ? 0 : -innerWidth * 0.17 * aside, tall ? innerHeight * 0.25 * aside : 0, innerWidth, innerHeight);
  } else if (camera.view) {
    camera.clearViewOffset();
  }
  camera.updateProjectionMatrix();
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);
  camera.aspect = width / height;
  starfieldUniforms.scale.value = pixelRatio * 1.5;
}

const projected = new THREE.Vector3();

// Where a point on the planet lands on screen, or null when it is over the horizon.
function onScreen(point) {
  const cameraDistance = camera.position.length();
  if (point.dot(camera.position) / (point.length() * cameraDistance) < R / cameraDistance - 0.04) return null;
  projected.copy(point).project(camera);
  if (projected.z > 1) return null;
  return [(projected.x * 0.5 + 0.5) * innerWidth, (-projected.y * 0.5 + 0.5) * innerHeight];
}

function updateTags() {
  for (const wanderer of players.values()) {
    const at = wanderer === me ? null : onScreen(surface(wanderer.dir, 1.75, scratch));
    wanderer.tag.style.opacity = at ? 1 : 0;
    if (at) wanderer.tag.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -100%)`;
  }
}

function pop(point, text, loss) {
  const at = onScreen(point);
  if (!at) return;
  const element = document.createElement("div");
  element.className = loss ? "pop loss" : "pop";
  element.textContent = text;
  element.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -100%)`;
  $("tags").append(element);
  setTimeout(() => element.remove(), 1150);
}

/* Play */

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function steer(dt, now) {
  if (now < me.stunnedUntil) return;
  let x = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
  let y = (keys.has("up") ? 1 : 0) - (keys.has("down") ? 1 : 0);
  if (!x && !y && joy.id !== null) {
    x = joy.x;
    y = -joy.y;
  }
  const push = Math.min(1, Math.hypot(x, y));
  if (push < 0.06) return;
  const right = scratch.crossVectors(cameraForward, me.dir).normalize();
  const heading = scratch2.copy(right).multiplyScalar(x).addScaledVector(cameraForward, y).normalize();
  const angle = (SPEED * push * dt) / R;
  const next = scratch3.copy(me.dir).multiplyScalar(Math.cos(angle)).addScaledVector(heading, Math.sin(angle)).normalize();
  for (const collider of colliders) {
    const reach = collider.r + 0.3;
    const gap = next.distanceTo(collider.d) * R;
    if (gap < reach && gap > 1e-4) {
      next.sub(collider.d).multiplyScalar(reach / gap).add(collider.d).normalize();
    }
  }
  me.facing.lerp(heading, 1 - Math.exp(-dt * 14));
  me.dir.copy(next);
  cameraForward.addScaledVector(me.dir, -cameraForward.dot(me.dir)).normalize();
}

function play(dt, now) {
  steer(dt, now);
  const clock = Date.now();
  if (clock - lastSent > 80 && me.dir.distanceToSquared(me.target) > 1e-7) {
    lastSent = clock;
    me.target.copy(me.dir);
    send({ t: "p", d: me.dir.toArray().map((value) => Number(value.toFixed(4))) });
  }
  if (phase !== "play") return;
  for (const star of stars.values()) {
    if (!star.landed || clock - star.claimed < 800) continue;
    if (arcBetween(me.dir, star.dir) < CATCH) {
      star.claimed = clock;
      send({ t: "c", id: star.id });
    }
  }
}

function updateClock(now) {
  const left = Math.max(0, endsAt - now);
  const seconds = Math.ceil(left / 1000);
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const swarm = phase === "play" && left < SWARM_MS;
  const key = `${phase}${text}${swarm}`;
  if (key === lastClock) return;
  lastClock = key;
  const timer = $("timer");
  timer.textContent = text;
  timer.classList.toggle("swarm", swarm);
  timer.classList.toggle("resting", phase !== "play");
  if (phase === "results") $("results-next").textContent = `Next round in ${seconds}`;
  if (swarm && !swarmAnnounced) {
    swarmAnnounced = true;
    toast("Starfall");
    chime([4, 6, 8], 0.12, 0.07);
  }
}

let lastFrame = performance.now();
// A device that can't keep up gives back resolution first, which is hard to see, then
// the glow, then the shadows.
const STEPS = [
  () => trim(1.5),
  () => trim(1),
  () => {
    bloom.enabled = false;
    return true;
  },
  () => {
    sun.castShadow = false;
    pixelRatio = 0.7;
    return true;
  },
];
let step = 0;
let probeStart = 0;
let probeFrames = 0;
let probeWorst = 0;
let slowProbes = 0;
let lastProbed = 0;
let trialFrom = 0;
let held = false;

function trim(limit) {
  if (pixelRatio <= limit) return false;
  pixelRatio = limit;
  return true;
}

function watchSpeed(time) {
  const gap = time - lastProbed;
  lastProbed = time;
  // A long gap is a hidden tab or a one-off stall, not the speed of the device.
  if (!me || held || step >= STEPS.length || blend < 1 || gap > 1000) {
    probeStart = 0;
    return;
  }
  if (!probeStart) {
    probeStart = time;
    probeFrames = 0;
    probeWorst = 0;
    return;
  }
  probeFrames += 1;
  probeWorst = Math.max(probeWorst, gap);
  if (time - probeStart < 2000) return;
  const rate = (probeFrames * 1000) / (time - probeStart);
  probeStart = 0;

  // A rock-steady 30 may be a power saver or the display holding the rate down, which
  // nothing here would lift. Lower the resolution once to find out, and if the rate
  // doesn't move, put it back and leave the picture alone.
  if (rate > 28 && rate < 31.5 && probeWorst < 50) {
    if (trialFrom) {
      pixelRatio = trialFrom;
      held = true;
    } else if (pixelRatio > 1) {
      trialFrom = pixelRatio;
      pixelRatio = Math.max(1, pixelRatio * 0.7);
    } else {
      held = true;
    }
    resize();
    return;
  }
  trialFrom = 0;

  // One slow stretch can be a hiccup; two in a row is the device.
  slowProbes = rate > 42 ? 0 : slowProbes + 1;
  if (slowProbes < 2) return;
  slowProbes = 0;
  // Far too slow takes two steps at once.
  let wanted = rate < 24 ? 2 : 1;
  while (wanted > 0 && step < STEPS.length) {
    if (STEPS[step]()) wanted -= 1;
    step += 1;
  }
  resize();
}

function frame(time) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (time - lastFrame) / 1000));
  lastFrame = time;
  const t = time / 1000;
  const now = serverNow();

  // Everyone in every room shares one slow sunset, set by the server's clock.
  const hour = ((now % SUN_CYCLE_MS) / SUN_CYCLE_MS) * TAU;
  sunDirection.set(Math.cos(hour), 0.22, Math.sin(hour)).normalize();
  sun.position.copy(sunDirection).multiplyScalar(45);
  moonlight.position.copy(sunDirection).multiplyScalar(-45);
  starfieldUniforms.time.value = t;

  if (me) {
    play(dt, now);
    updateClock(now);
  }
  for (const wanderer of players.values()) animateWanderer(wanderer, dt, t, now);
  updateStars(now, t);
  updateMeteors(now, t);
  updateRings(dt);
  updateSparks(dt);
  placeCamera(dt, t);
  sky.position.copy(camera.position);
  composer.render(dt);
  if (!startPanel.hidden) preview.draw(t, dt);
  updateTags();
  watchSpeed(time);
}

/* Interface */

function toast(text) {
  const element = $("toast");
  element.textContent = text;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 1900);
}

function swatch(wanderer) {
  const dot = document.createElement("i");
  dot.style.background = css(wanderer.c);
  return dot;
}

function ranked() {
  return [...players.values()].sort((a, b) => b.score - a.score || a.id - b.id);
}

function renderScores() {
  const list = $("scores");
  list.textContent = "";
  const order = ranked();
  const shown = order.slice(0, 5);
  if (me && !shown.includes(me)) shown[shown.length - 1] = me;
  for (const wanderer of shown) {
    const row = document.createElement("li");
    if (wanderer === me) row.className = "me";
    const name = document.createElement("b");
    name.textContent = wanderer.name;
    const score = document.createElement("span");
    score.textContent = wanderer.score;
    row.append(swatch(wanderer), name, score);
    list.append(row);
  }
}

function renderResults() {
  const order = ranked();
  const winner = order[0];
  const title = $("results-title");
  if (!winner || winner.score === 0) title.textContent = "Nobody caught a thing";
  else if (winner === me) title.textContent = "The round is yours";
  else title.textContent = `${winner.name} takes the round`;
  const list = $("results-list");
  list.textContent = "";
  order.slice(0, 6).forEach((wanderer, index) => {
    const row = document.createElement("li");
    if (wanderer === me) row.className = "me";
    const place = document.createElement("em");
    place.textContent = index + 1;
    const name = document.createElement("b");
    name.textContent = wanderer === me ? `${wanderer.name} (you)` : wanderer.name;
    const score = document.createElement("span");
    score.textContent = wanderer.score;
    row.append(place, swatch(wanderer), name, score);
    list.append(row);
  });
  $("results").hidden = false;
  if (winner === me && winner.score > 0) chime([0, 2, 4, 7, 9], 0.14);
  else chime([4, 2, 0], 0.18, 0.07);
}

function showStatus(title, text, action) {
  $("status-title").textContent = title;
  $("status-text").textContent = text;
  $("status-action").hidden = !action;
  $("status-action").textContent = action || "";
  $("status").hidden = false;
  $("results").hidden = true;
}

function showGame(shown) {
  for (const id of ["hud", "scores", "call"]) $(id).hidden = !shown;
}

/* Network */

function setPhase(message) {
  phase = message.phase;
  endsAt = message.endsAt;
  lastClock = "";
  if (phase === "play") {
    swarmAnnounced = false;
    $("results").hidden = true;
  }
}

function handle(message) {
  if (message.t === "welcome") {
    retries = 0;
    clockOffset = message.now - Date.now();
    bestPing = Infinity;
    myId = message.id;
    clearWanderers();
    clearStars();
    clearMeteors();
    const now = serverNow();
    for (const data of message.players) players.set(data.id, makeWanderer(data));
    for (const star of message.stars) addStar(star, now);
    for (const meteor of message.meteors) addMeteor(meteor);
    me = players.get(myId);
    me.figure.add(myMark, myLight);
    // Someone got there first, so the planet chose the next figure or colour along.
    if (me.ch !== profile.ch) toast(`The ${CHARACTERS[profile.ch]} was taken, so you are the ${CHARACTERS[me.ch]}`);
    else if (me.c !== profile.c) toast("That colour was taken, so here is another");
    cameraForward.copy(tangents(me.dir)[0]);
    setPhase(message);
    $("start").hidden = true;
    $("status").hidden = true;
    showGame(true);
    renderScores();
    if (phase === "results") renderResults();
    for (let i = 0; i < 3; i += 1) setTimeout(() => send({ t: "ping", c: Date.now() }), 200 + i * 400);
  } else if (!me) {
    return;
  } else if (message.t === "s") {
    for (const [id, x, y, z] of message.ps) {
      const wanderer = players.get(id);
      if (wanderer && wanderer !== me) wanderer.target.set(x, y, z).normalize();
    }
  } else if (message.t === "star") {
    addStar(message.f, serverNow());
  } else if (message.t === "got") {
    const star = stars.get(message.id);
    const wanderer = players.get(message.by);
    if (star) removeStar(star);
    if (!wanderer) return;
    wanderer.score = message.s;
    wanderer.cheer = 1;
    const kind = star ? star.k : 0;
    const where = star ? star.dir : wanderer.dir;
    burst(surface(where, 0.8, scratch), where, STAR_TINT[kind], kind ? 30 : 16, kind ? 5 : 3.6);
    ripple(where, STAR_TINT[kind].clone().multiplyScalar(1.5), 0.3, kind ? 2.6 : 1.8, 0.6);
    if (wanderer === me) {
      const clock = Date.now();
      streak = clock - lastCatch < 3500 ? Math.min(streak + 1, SCALE.length - 3) : 0;
      lastCatch = clock;
      if (kind) chime([streak, streak + 1, streak + 2], 0.08, 0.13);
      else bell(SCALE[streak]);
      if (navigator.vibrate) navigator.vibrate(kind ? [12, 30, 12] : 10);
      pop(surface(where, 1.6, scratch), `+${STAR_POINTS[kind]}`, false);
    } else {
      bell(SCALE[kind ? 4 : 1] / 2, 0, 0.03 * clamp(1.3 - arcBetween(me.dir, where) / 14, 0, 1));
    }
    renderScores();
  } else if (message.t === "m") {
    addMeteor(message);
  } else if (message.t === "hit") {
    const now = serverNow();
    for (const [id, score] of message.ps) {
      const wanderer = players.get(id);
      if (!wanderer) continue;
      const lost = wanderer.score - score;
      wanderer.score = score;
      wanderer.stunnedUntil = now + STUN_MS;
      if (wanderer !== me) continue;
      pop(surface(me.dir, 1.6, scratch), lost > 0 ? `−${lost}` : "Struck", true);
      if (navigator.vibrate) navigator.vibrate([40, 40, 80]);
    }
    if (message.ps.length) renderScores();
  } else if (message.t === "phase") {
    const wasPlaying = phase === "play";
    setPhase(message);
    clearStars();
    clearMeteors();
    if (phase === "play") {
      for (const wanderer of players.values()) wanderer.score = 0;
      renderScores();
      toast(`Round ${message.round}`);
      chime([0, 2, 4], 0.1, 0.08);
    } else if (wasPlaying) {
      renderResults();
    }
  } else if (message.t === "look") {
    const wanderer = players.get(message.id);
    if (wanderer) redress(wanderer, message.ch);
  } else if (message.t === "join") {
    players.set(message.p.id, makeWanderer(message.p));
    if (!message.p.bot) toast(`${message.p.name} has landed`);
    renderScores();
  } else if (message.t === "leave") {
    const wanderer = players.get(message.id);
    if (wanderer) removeWanderer(wanderer);
    players.delete(message.id);
    renderScores();
  } else if (message.t === "e") {
    const wanderer = players.get(message.id);
    if (wanderer && wanderer !== me) callOut(wanderer);
  } else if (message.t === "pong") {
    const ping = Date.now() - message.c;
    if (ping >= 0 && ping < bestPing) {
      bestPing = ping;
      clockOffset = message.now + ping / 2 - Date.now();
    }
  }
}

function closed(code) {
  clearWanderers();
  clearStars();
  clearMeteors();
  joy.id = null;
  joystick.hidden = true;
  keys.clear();
  $("results").hidden = true;
  showGame(false);
  if (leaving) {
    // Back to the menu, with their figure and colour free for someone else.
    leaving = false;
    $("status").hidden = true;
    startPanel.hidden = false;
    showChoice();
    watchLobby();
    return;
  }
  if (asleep) return;
  if (code === 4001) {
    showStatus("Still there?", "You drifted off, so the planet let your place go.", "Return");
  } else if (code === 4002) {
    if (!room.startsWith(PUBLIC_ROOM)) toast("That world is full");
    publicIndex = room.startsWith(PUBLIC_ROOM) ? publicIndex + 1 : 1;
    enter(publicIndex > 1 ? `${PUBLIC_ROOM}-${publicIndex}` : PUBLIC_ROOM);
  } else if (retries < 4) {
    showStatus("One moment", "Finding the planet again.", "");
    retryTimer = setTimeout(connect, 500 * 2 ** retries);
    retries += 1;
  } else {
    retries = 0;
    showStatus("Out of reach", "The planet isn’t answering. Check your connection and try again.", "Try again");
  }
}

function connect() {
  clearTimeout(retryTimer);
  const socket = new WebSocket(`${SERVER}/r/${room}`);
  ws = socket;
  socket.onopen = () => send({ t: "hi", name: profile.name, c: profile.c, ch: profile.ch });
  socket.onmessage = (event) => {
    if (ws === socket) handle(JSON.parse(event.data));
  };
  socket.onclose = (event) => {
    if (ws !== socket) return;
    ws = null;
    closed(event.code);
  };
}

function enter(name) {
  room = name;
  const url = new URL(location.href);
  if (room.startsWith(PUBLIC_ROOM)) url.searchParams.delete("room");
  else url.searchParams.set("room", room);
  history.replaceState(null, "", url);
  connect();
}

/* Controls */

const KEYS = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  a: "left", d: "right", w: "up", s: "down",
};

// A call is a ring of light and a note: the only thing wanderers can say.
function callOut(wanderer) {
  wanderer.cheer = 1;
  ripple(wanderer.dir, wanderer.color.clone().multiplyScalar(1.8), 0.4, 2.8, 1.1);
  burst(surface(wanderer.dir, 1.2, scratch), wanderer.dir, wanderer.color, 10, 2.5);
  const closeness = me ? clamp(1.2 - arcBetween(me.dir, wanderer.dir) / 16, 0.1, 1) : 0;
  bell(SCALE[2 + (wanderer.id % 6)], 0, 0.09 * closeness);
}

let lastCall = 0;

function call() {
  if (!me || performance.now() - lastCall < 450) return;
  lastCall = performance.now();
  callOut(me);
  send({ t: "e" });
}

window.addEventListener("keydown", (event) => {
  if (!me || event.target === $("name") || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = KEYS[event.key] || KEYS[event.key.toLowerCase()];
  if (key) {
    keys.add(key);
    event.preventDefault();
  } else if (event.key === " " || event.key.toLowerCase() === "e") {
    if (!event.repeat) call();
    event.preventDefault();
  }
});
window.addEventListener("keyup", (event) => {
  const key = KEYS[event.key] || KEYS[event.key.toLowerCase()];
  if (key) keys.delete(key);
});
window.addEventListener("blur", () => keys.clear());

const joystick = document.createElement("div");
const knob = document.createElement("div");
joystick.hidden = true;
joystick.style.cssText = "position:absolute;left:0;top:0;width:96px;height:96px;margin:-48px 0 0 -48px;border-radius:50%;border:1px solid rgba(244,236,223,.4);pointer-events:none";
knob.style.cssText = "position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(244,236,223,.75)";
joystick.append(knob);
document.body.append(joystick);

function drawJoystick() {
  joystick.style.transform = `translate(${joy.originX}px, ${joy.originY}px)`;
  knob.style.transform = `translate(${joy.x * 48}px, ${joy.y * 48}px)`;
}

canvas.addEventListener("pointerdown", (event) => {
  wakeAudio();
  if (!me || joy.id !== null) return;
  joy.id = event.pointerId;
  joy.originX = event.clientX;
  joy.originY = event.clientY;
  joy.x = 0;
  joy.y = 0;
  joystick.hidden = false;
  drawJoystick();
});
window.addEventListener("pointermove", (event) => {
  if (event.pointerId !== joy.id) return;
  let dx = event.clientX - joy.originX;
  let dy = event.clientY - joy.originY;
  const length = Math.hypot(dx, dy);
  // The stick stays where the thumb first came down; only a new touch moves it.
  if (length > 48) {
    dx = (dx / length) * 48;
    dy = (dy / length) * 48;
  }
  joy.x = dx / 48;
  joy.y = dy / 48;
  drawJoystick();
});
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, (event) => {
    if (event.pointerId !== joy.id) return;
    joy.id = null;
    joystick.hidden = true;
  });
}
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener("touchmove", (event) => {
  if (event.target === canvas) event.preventDefault();
}, { passive: false });

$("call").addEventListener("click", call);

$("leave").addEventListener("click", () => {
  if (!ws) return;
  leaving = true;
  ws.close();
});

function showSound() {
  $("sound").setAttribute("aria-pressed", String(profile.muted));
  $("sound").setAttribute("aria-label", profile.muted ? "Turn sound on" : "Turn sound off");
}

$("sound").addEventListener("click", () => {
  profile.muted = !profile.muted;
  saveProfile();
  showSound();
  if (profile.muted && voices) voices.gain.value = 0;
  wakeAudio();
  if (!profile.muted) bell(SCALE[4]);
});
showSound();

$("invite").addEventListener("click", async () => {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", room);
  $("invite").classList.remove("nudge");
  if (navigator.share) {
    try {
      await navigator.share({ title: "Starfall", text: "Come catch stars on a very small planet.", url: url.href });
    } catch (error) {
      // The share sheet was dismissed.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url.href);
    toast("Link copied");
  } catch (error) {
    window.prompt("Share this link", url.href);
  }
});

function start(name) {
  const typed = $("name").value.replace(/\s+/g, " ").trim().slice(0, 12);
  profile.name = typed || pick(NAMES);
  saveProfile();
  wakeAudio();
  $("start").hidden = true;
  stopWatching();
  enter(name);
}

function roomCode() {
  const letters = "abcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) code += pick(letters);
  return code;
}

const invited = (new URLSearchParams(location.search).get("room") || "").toLowerCase();
const invitedRoom = /^[a-z0-9-]{1,24}$/.test(invited) && !invited.startsWith(PUBLIC_ROOM) ? invited : "";

$("name").value = profile.name;
if (invitedRoom) {
  $("play").textContent = "Join them";
  $("friends").textContent = "Public world";
}

/* Choosing who to be: one figure and one colour each, and no two alike in a world */

const startPanel = $("start");
// What the people already in the world are using.
const lobby = { c: new Set(), ch: new Set() };

// A turning, idling copy of the chosen figure, drawn by a small renderer of its own.
const preview = (() => {
  const view = $("figure");
  const world = new THREE.Scene();
  const eye = new THREE.PerspectiveCamera(27, 1, 0.1, 30);
  const key = new THREE.DirectionalLight(0xffd3a6, 3.3);
  key.position.set(-3.6, 4.4, 3.4);
  const rim = new THREE.DirectionalLight(0x7f95ff, 1.5);
  rim.position.set(3.6, 2.2, -4);
  const turntable = new THREE.Group();
  world.add(key, rim, new THREE.AmbientLight(0x5c68c4, 1.3), turntable);
  const state = { t: 0, dt: 0, move: 0, stride: 0, cheer: 0, hop: 0, flash: 0 };
  let small = null;
  let character = null;
  let shown = -1;
  let cheer = 0;
  let width = 0;
  let height = 0;
  return {
    show(ch, c) {
      if (ch !== shown) {
        if (character) {
          turntable.remove(character.root);
          character.dispose();
        }
        character = makeCharacter(ch);
        turntable.add(character.root);
        if (shown >= 0) cheer = 1;
        shown = ch;
        const [level, back] = FRAMING[ch];
        eye.position.set(0, level + 0.5, back * 0.6);
        eye.lookAt(0, level - 0.03, 0);
      }
      character.paint(new THREE.Color(COLORS[c]));
    },
    draw(t, dt) {
      if (!character) return;
      if (!small) {
        small = new THREE.WebGLRenderer({ canvas: view, antialias: true, alpha: true });
        small.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        small.toneMapping = THREE.ACESFilmicToneMapping;
        small.toneMappingExposure = 1.08;
      }
      if (view.clientWidth !== width || view.clientHeight !== height) {
        width = view.clientWidth;
        height = view.clientHeight;
        small.setSize(width, height, false);
        eye.aspect = width / Math.max(1, height);
        eye.updateProjectionMatrix();
      }
      cheer = Math.max(0, cheer - dt * 1.9);
      state.t = t;
      state.dt = dt;
      state.cheer = cheer;
      state.hop = cheer * Math.sin(cheer * Math.PI);
      turntable.rotation.y = 0.45 + Math.sin(t * 0.5) * 0.6;
      character.update(state);
      small.render(world, eye);
    },

  };
})();

function spare(taken, from, step, count) {
  for (let i = 1; i <= count; i += 1) {
    const next = (((from + step * i) % count) + count) % count;
    if (!taken.has(next)) return next;
  }
  return from;
}

function showChoice() {
  const free = CHARACTERS.length - lobby.ch.size;
  $("figure-name").textContent = CHARACTERS[profile.ch];
  $("figure-note").textContent = lobby.ch.size ? `${free} of ${CHARACTERS.length} free in this world` : "";
  [...$("swatches").children].forEach((button, index) => {
    button.disabled = lobby.c.has(index);
    button.setAttribute("aria-checked", String(index === profile.c));
  });
  preview.show(profile.ch, profile.c);
}

// Moves the choice off anything somebody in the world already has.
function settle() {
  if (lobby.ch.has(profile.ch)) profile.ch = spare(lobby.ch, profile.ch, 1, CHARACTERS.length);
  if (lobby.c.has(profile.c)) profile.c = spare(lobby.c, profile.c, 1, COLORS.length - 1);
  showChoice();
}

function turnFigure(step) {
  profile.ch = spare(lobby.ch, profile.ch, step, CHARACTERS.length);
  saveProfile();
  showChoice();
  wakeAudio();
  bell(SCALE[profile.ch % SCALE.length], 0, 0.05);
}

// While the start screen is up, the room says at once when a figure or colour is taken
// or let go. If that line drops, the room still settles any clash when they join.
let watcher = null;
let watchTimer = 0;

function watchLobby() {
  clearTimeout(watchTimer);
  if (watcher || startPanel.hidden || document.hidden) return;
  const socket = new WebSocket(`${SERVER}/r/${invitedRoom || PUBLIC_ROOM}?watch`);
  watcher = socket;
  socket.onmessage = (event) => {
    if (watcher !== socket) return;
    const world = JSON.parse(event.data);
    lobby.c = new Set(world.c);
    lobby.ch = new Set(world.ch);
    settle();
  };
  socket.onclose = () => {
    if (watcher !== socket) return;
    watcher = null;
    watchTimer = setTimeout(watchLobby, 4000);
  };
}

function stopWatching() {
  clearTimeout(watchTimer);
  const socket = watcher;
  watcher = null;
  if (socket) socket.close();
}

for (let index = 0; index < COLORS.length - 1; index += 1) {
  const button = document.createElement("button");
  button.type = "button";
  button.style.background = css(index);
  button.setAttribute("role", "radio");
  button.setAttribute("aria-label", `Colour ${index + 1}`);
  button.addEventListener("click", () => {
    profile.c = index;
    saveProfile();
    showChoice();
    wakeAudio();
    bell(SCALE[index], 0, 0.06);
  });
  $("swatches").append(button);
}
$("figure-prev").addEventListener("click", () => turnFigure(-1));
$("figure-next").addEventListener("click", () => turnFigure(1));
$("figure").addEventListener("click", () => turnFigure(1));
showChoice();
watchLobby();
document.addEventListener("visibilitychange", () => (document.hidden ? stopWatching() : watchLobby()));

$("play").addEventListener("click", () => start(invitedRoom || PUBLIC_ROOM));
$("friends").addEventListener("click", () => {
  if (invitedRoom) return start(PUBLIC_ROOM);
  start(roomCode());
  setTimeout(() => toast("A world of your own. Invite someone."), 2400);
  $("invite").classList.add("nudge");
});
$("name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("play").click();
});

$("status-action").addEventListener("click", () => {
  $("status").hidden = true;
  wakeAudio();
  connect();
});

// A hidden tab gives up its place, then quietly returns.
document.addEventListener("visibilitychange", () => {
  clearTimeout(sleepTimer);
  if (document.hidden) {
    sleepTimer = setTimeout(() => {
      if (!ws) return;
      asleep = true;
      ws.close();
    }, 20000);
  } else if (asleep) {
    asleep = false;
    connect();
  }
});

window.addEventListener("resize", resize);
resize();
canvas.classList.add("ready");
// Draw one of everything behind the title, so its shaders are ready before the first round.
{
  const sample = [0.6, 0.5, 0.62];
  const everyone = CHARACTERS.map((name, ch) => makeWanderer({ id: -1, name: "", c: 0, ch, d: sample }));
  const wanderer = everyone[0];
  addStar({ id: -1, k: 0, t0: 0, d: sample }, 0);
  addStar({ id: -2, k: 1, t0: 0, d: sample }, 0);
  addMeteor({ id: -1, at: 0, d: sample });
  ripple(wanderer.dir, WAKE, 0.2, 0.5, 1);
  renderer.compile(scene, camera);
  everyone.forEach(removeWanderer);
  clearStars();
  clearMeteors();
  for (const ring of rings.splice(0)) {
    scene.remove(ring.mesh);
    ring.material.dispose();
  }
}

requestAnimationFrame(frame);
