// The figures players wear, in the order of CHARACTERS in shared.js. Each stands on
// y = 0, faces +z, and is posed every frame from a small state:
//   t, dt  seconds
//   move   0 standing … 1 running
//   stride an angle that advances while running
//   cheer  1 … 0 after catching a star, and hop, the height of that jump
//   flash  extra glow while stunned
import * as THREE from "three";

const INK = 0x1d1f3a;
const PALE = 0xf4eadc;
const WOOD = 0x4a382d;
const STRAW = 0xead9b2;
const WHITE = new THREE.Color(1, 1, 1);
const STONE = new THREE.Color(0xcdd0e2);
const TAU = Math.PI * 2;
const { sin, cos, abs, max, PI } = Math;

const flat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8, ...extra });
const glowing = () => new THREE.MeshBasicMaterial({ color: 0xffffff });
const lathe = (points, around = 10) => new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), around);

function mesh(geometry, material, x = 0, y = 0, z = 0) {
  const made = new THREE.Mesh(geometry, material);
  made.position.set(x, y, z);
  // Eyes, strings and the like are too small for their shadows to be seen from the
  // game's camera, so they are not drawn into the shadow map.
  geometry.computeBoundingSphere();
  made.castShadow = geometry.boundingSphere.radius > 0.07;
  return made;
}

// Lights, and the small parts that hang off them, leave shadows to the body.
function lit(geometry, x = 0, y = 0, z = 0) {
  const made = mesh(geometry, glowing(), x, y, z);
  made.castShadow = false;
  return made;
}

function group(parent, x = 0, y = 0, z = 0) {
  const made = new THREE.Group();
  made.position.set(x, y, z);
  parent.add(made);
  return made;
}

let haloTexture = null;
// How strong the painted-on glow is: full where nothing else blooms, faint in the game.
let mist = 1;

function halo(parent, size, opacity = 0.6) {
  if (!haloTexture) {
    const dot = document.createElement("canvas");
    dot.width = dot.height = 128;
    const c = dot.getContext("2d");
    const fill = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    fill.addColorStop(0, "rgba(255,255,255,0.95)");
    fill.addColorStop(0.25, "rgba(255,255,255,0.35)");
    fill.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = fill;
    c.fillRect(0, 0, 128, 128);
    haloTexture = new THREE.CanvasTexture(dot);
  }
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTexture,
      transparent: true,
      opacity: opacity * mist,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sprite.scale.setScalar(size);
  sprite.visible = mist > 0;
  parent.add(sprite);
  return sprite;
}

// A strip of cloth that hangs when still and streams behind when moving.
class Ribbon {
  constructor(parent, count, width, material) {
    this.count = count;
    this.width = width;
    this.array = new Float32Array(count * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.array, 3));
    const index = [];
    for (let i = 0; i < count - 1; i += 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geometry.setIndex(index);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  stream(s, x, y, z, length, phase = 0, droop = 0.85) {
    const array = this.array;
    for (let i = 0; i < this.count; i += 1) {
      const u = i / (this.count - 1);
      const quick = 3 + 6 * s.move;
      const px = x + sin(s.t * quick - u * 5 + phase) * u * (0.035 + 0.06 * s.move);
      const py = y - u * length * (1 - s.move) * droop - u * u * length * 0.12 + cos(s.t * quick * 0.8 - u * 4 + phase) * u * 0.05 * s.move;
      const pz = z - u * length * (0.25 + 0.75 * s.move);
      const twist = 1.15 + sin(s.t * 2.1 - u * 3 + phase) * 0.5;
      const half = this.width * 0.5 * (1 - 0.45 * u);
      const at = i * 6;
      array[at] = px - cos(twist) * half;
      array[at + 1] = py - sin(twist) * half;
      array[at + 2] = pz;
      array[at + 3] = px + cos(twist) * half;
      array[at + 4] = py + sin(twist) * half;
      array[at + 5] = pz;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }
}

// Lets the lower part of a cloak lag behind and flutter.
function hem(geometry, top, back = 0.16) {
  const position = geometry.attributes.position;
  const base = position.array.slice();
  return (s) => {
    for (let i = 0; i < position.count; i += 1) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
      if (y >= top) continue;
      const w = ((top - y) / top) ** 2;
      const flutter = 0.012 * w * (1 + 2.5 * s.move);
      position.setXYZ(
        i,
        x + sin(s.t * 2.6 + z * 9 + y * 7) * flutter,
        y + (z < 0 ? s.move * back * 0.4 * w : 0),
        z - s.move * back * w + sin(s.t * 3.3 + x * 9 + y * 5) * flutter,
      );
    }
    position.needsUpdate = true;
  };
}

function lamp(parent, size) {
  const holder = group(parent);
  const core = lit(new THREE.IcosahedronGeometry(size, 1));
  const cap = mesh(new THREE.ConeGeometry(size * 1.15, size * 0.9, 6), flat(INK), 0, size * 1.15, 0);
  const foot = mesh(new THREE.CylinderGeometry(size * 0.7, size * 0.5, size * 0.35, 6), flat(INK), 0, -size * 1.05, 0);
  cap.castShadow = false;
  foot.castShadow = false;
  holder.add(core, cap, foot);
  const glow = halo(holder, size * 11, 0.55);
  return {
    holder,
    paint(color, gain) {
      core.material.color.copy(color).lerp(WHITE, 0.45).multiplyScalar(1.7 * gain);
      glow.material.color.copy(color).lerp(WHITE, 0.2);
    },
    flare(amount) {
      glow.scale.setScalar(size * 11 * (1 + amount));
    },
  };
}

// A tapered bar hanging down from a joint, or standing up from one.
function limb(parent, length, top, bottom, material, x = 0, y = 0, z = 0, up = false) {
  const pivot = group(parent, x, y, z);
  const geometry = up
    ? new THREE.CylinderGeometry(bottom, top, length, 5).translate(0, length / 2, 0)
    : new THREE.CylinderGeometry(top, bottom, length, 5).translate(0, -length / 2, 0);
  pivot.add(mesh(geometry, material));
  return pivot;
}

function wanderer(root) {
  const main = flat(0xffffff, { side: THREE.DoubleSide });
  const pale = flat(PALE);
  const body = group(root);
  body.add(
    mesh(lathe([[0.002, 0.93], [0.12, 0.9], [0.19, 0.66], [0.29, 0.24], [0.37, 0]], 9), main),
    mesh(new THREE.IcosahedronGeometry(0.165, 1), pale, 0, 1.05, 0),
    mesh(new THREE.TorusGeometry(0.15, 0.05, 5, 9).rotateX(PI / 2), pale, 0, 0.88, 0),
  );
  const lantern = lit(new THREE.IcosahedronGeometry(0.055, 1));
  const glow = halo(lantern, 0.5, 0.5);
  body.add(lantern);
  return {
    paint(color, gain) {
      main.color.copy(color);
      main.emissive.copy(color);
      lantern.material.color.copy(color).lerp(WHITE, 0.3).multiplyScalar(1.55 * gain);
      glow.material.color.copy(color);
    },
    update(s) {
      body.position.y = abs(sin(s.stride)) * 0.07 * s.move + 0.35 * s.hop;
      body.rotation.x = 0.16 * s.move;
      body.rotation.z = sin(s.stride) * 0.05 * s.move;
      main.emissiveIntensity = 0.16 + s.cheer * 0.5 + s.flash;
      lantern.position.set(0.36, 0.66 + sin(s.t * 2.3) * 0.06, 0.12);
    },
  };
}

function pilgrim(root) {
  const main = flat(0xffffff, { side: THREE.DoubleSide });
  const deep = flat(0xffffff, { side: THREE.DoubleSide });
  const cloth = flat(0xffffff, { side: THREE.DoubleSide, emissiveIntensity: 0.12 });
  const ink = flat(INK);
  const wood = flat(WOOD);
  const body = group(root);

  const cloakGeometry = lathe([[0.02, 0.92], [0.15, 0.87], [0.2, 0.64], [0.27, 0.32], [0.35, 0.05]], 11);
  const sway = hem(cloakGeometry, 0.5);
  body.add(mesh(cloakGeometry, deep));
  body.add(mesh(lathe([[0.002, 0.99], [0.13, 0.95], [0.25, 0.8], [0.28, 0.68]], 11), main));

  // The hood comes to a point that sweeps back, and is pressed flat where the face looks out.
  const head = group(body, 0, 1.04, 0.01);
  const hoodGeometry = lathe([[0.002, 0.31], [0.09, 0.26], [0.18, 0.15], [0.22, 0], [0.2, -0.12], [0.15, -0.2]], 11);
  const hood = hoodGeometry.attributes.position;
  for (let i = 0; i < hood.count; i += 1) {
    const y = hood.getY(i);
    let z = hood.getZ(i);
    if (z > 0.07 && y < 0.2) z = 0.07 + (z - 0.07) * 0.2;
    if (y > 0.1) z -= (y - 0.1) * 1.25;
    hood.setZ(i, z);
  }
  head.add(mesh(hoodGeometry, main));
  head.add(mesh(new THREE.IcosahedronGeometry(0.16, 2).scale(0.92, 1, 0.72), ink, 0, -0.01, 0.035));
  const eyes = [-1, 1].map((side) => {
    const eye = lit(new THREE.IcosahedronGeometry(0.02, 1), side * 0.056, 0, 0.148);
    head.add(eye);
    return eye;
  });

  const scarves = [new Ribbon(body, 12, 0.12, cloth), new Ribbon(body, 10, 0.09, cloth)];
  const feet = [-1, 1].map((side) => mesh(new THREE.BoxGeometry(0.09, 0.06, 0.15), ink, side * 0.1, 0.03, 0.02));
  root.add(...feet);

  const staff = group(body, 0.37, 0, 0.14);
  staff.add(mesh(new THREE.CylinderGeometry(0.012, 0.016, 1.3, 5).translate(0, 0.65, 0), wood));
  staff.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.16, 4).rotateX(PI / 2), wood, 0, 1.27, 0.07));
  staff.add(mesh(new THREE.IcosahedronGeometry(0.04, 1), flat(PALE), 0, 0.66, 0));
  const hang = group(staff, 0, 1.27, 0.15);
  hang.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.1, 3).translate(0, -0.05, 0), ink));
  const light = lamp(hang, 0.05);
  light.holder.position.y = -0.17;

  return {
    paint(color, gain) {
      main.color.copy(color);
      main.emissive.copy(color);
      deep.color.copy(color).multiplyScalar(0.62);
      cloth.color.copy(color).lerp(WHITE, 0.55);
      cloth.emissive.copy(cloth.color);
      for (const eye of eyes) eye.material.color.copy(color).lerp(WHITE, 0.75).multiplyScalar(1.5 * gain);
      light.paint(color, gain);
    },
    update(s) {
      body.position.y = abs(sin(s.stride)) * 0.05 * s.move + 0.34 * s.hop + sin(s.t * 1.6) * 0.006;
      body.rotation.x = 0.17 * s.move;
      body.rotation.z = sin(s.stride) * 0.04 * s.move;
      main.emissiveIntensity = 0.1 + s.cheer * 0.4 + s.flash;
      head.rotation.y = sin(s.t * 0.55) * 0.3 * (1 - s.move);
      head.rotation.x = -0.1 * s.move - 0.25 * s.hop;
      const blink = s.t % 3.4 < 0.11 ? 0.12 : 1;
      for (const eye of eyes) eye.scale.set(1, blink, 1);
      sway(s);
      scarves[0].stream(s, 0.05, 0.9, -0.17, 0.95, 0);
      scarves[1].stream(s, -0.06, 0.9, -0.17, 0.7, 1.7);
      feet.forEach((foot, i) => {
        const phase = s.stride + i * PI;
        foot.position.z = 0.02 + sin(phase) * 0.15 * s.move;
        foot.position.y = 0.03 + max(0, cos(phase)) * 0.08 * s.move + 0.34 * s.hop;
      });
      staff.rotation.x = 0.1 + 0.12 * s.move - 0.5 * s.hop;
      staff.position.y = abs(sin(s.stride + 0.6)) * 0.04 * s.move + 0.12 * s.hop;
      hang.rotation.x = -staff.rotation.x - body.rotation.x + sin(s.stride) * 0.3 * s.move + sin(s.t * 1.7) * 0.07;
      hang.rotation.z = sin(s.t * 1.3) * 0.06;
      light.flare(s.cheer * 1.2);
    },
  };
}

function lamplighter(root) {
  const main = flat(0xffffff, { side: THREE.DoubleSide });
  const deep = flat(0xffffff, { side: THREE.DoubleSide });
  const ink = flat(INK);
  const pale = flat(PALE);
  const body = group(root);

  const legs = [-1, 1].map((side) => {
    const thigh = limb(body, 0.3, 0.045, 0.034, ink, side * 0.075, 0.62, 0);
    const shin = limb(thigh, 0.3, 0.034, 0.024, ink, 0, -0.3, 0);
    shin.add(mesh(new THREE.BoxGeometry(0.06, 0.04, 0.14), ink, 0, -0.3, 0.04));
    return { thigh, shin };
  });

  const torso = group(body, 0, 0.02, 0);
  const coatGeometry = lathe([[0.002, 1.2], [0.08, 1.18], [0.145, 1.08], [0.125, 0.84], [0.17, 0.6], [0.25, 0.4]], 10);
  const sway = hem(coatGeometry, 0.66, 0.2);
  torso.add(mesh(coatGeometry, main));
  torso.add(mesh(new THREE.TorusGeometry(0.128, 0.018, 4, 10).rotateX(PI / 2), pale, 0, 0.84, 0));
  const tails = [new Ribbon(torso, 8, 0.13, deep), new Ribbon(torso, 8, 0.13, deep)];

  const head = group(torso, 0, 1.27, 0);
  head.add(mesh(new THREE.IcosahedronGeometry(0.1, 1), pale));
  const hat = group(head, 0, 0.07, 0);
  hat.add(mesh(new THREE.ConeGeometry(0.37, 0.19, 11).translate(0, 0.095, 0), flat(STRAW)));
  hat.add(mesh(new THREE.CylinderGeometry(0.115, 0.135, 0.035, 11), main, 0, 0.115, 0));
  hat.rotation.x = 0.1;

  const leftArm = limb(torso, 0.4, 0.034, 0.024, main, -0.15, 1.1, 0);
  leftArm.rotation.z = -0.16;
  leftArm.add(mesh(new THREE.IcosahedronGeometry(0.034, 1), pale, 0, -0.41, 0));
  const rightArm = limb(torso, 0.36, 0.034, 0.024, main, 0.15, 1.1, 0);
  rightArm.rotation.z = 0.12;
  rightArm.add(mesh(new THREE.IcosahedronGeometry(0.034, 1), pale, 0, -0.37, 0));

  const pole = group(torso, 0.2, 0.9, 0.3);
  pole.add(mesh(new THREE.CylinderGeometry(0.009, 0.014, 1.2, 5).translate(0, 0.42, 0), flat(WOOD)));
  const hang = group(pole, 0, 1.02, 0);
  hang.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.16, 3).translate(0, -0.08, 0), ink));
  const light = lamp(hang, 0.058);
  light.holder.position.y = -0.24;

  return {
    paint(color, gain) {
      main.color.copy(color);
      main.emissive.copy(color);
      deep.color.copy(color).multiplyScalar(0.6);
      light.paint(color, gain);
    },
    update(s) {
      body.position.y = (abs(cos(s.stride)) - 0.6) * 0.05 * s.move + 0.36 * s.hop;
      main.emissiveIntensity = 0.08 + s.cheer * 0.4 + s.flash;
      torso.rotation.x = 0.13 * s.move + sin(s.t * 1.4) * 0.008;
      torso.rotation.z = sin(s.stride) * 0.035 * s.move;
      legs.forEach(({ thigh, shin }, i) => {
        const phase = s.stride + i * PI;
        thigh.rotation.x = -sin(phase) * 0.75 * s.move - 0.5 * s.hop;
        shin.rotation.x = (0.12 + max(0, cos(phase)) * 1.05) * s.move + 1.0 * s.hop;
      });
      leftArm.rotation.x = sin(s.stride + PI) * 0.6 * s.move + sin(s.t * 1.4) * 0.04 - 2.4 * s.hop;
      rightArm.rotation.x = -1.05 + sin(s.stride) * 0.08 * s.move - 0.5 * s.hop;
      head.rotation.y = sin(s.t * 0.5) * 0.35 * (1 - s.move);
      hat.position.y = 0.07 + 0.1 * s.hop;
      hat.rotation.z = sin(s.stride) * 0.05 * s.move;
      sway(s);
      tails[0].stream(s, -0.07, 0.62, -0.16, 0.46, 0, 0.95);
      tails[1].stream(s, 0.07, 0.62, -0.16, 0.46, 2.1, 0.95);
      pole.rotation.x = 0.78 + sin(s.stride * 2) * 0.03 * s.move - 0.55 * s.hop;
      pole.position.y = 0.9 + 0.1 * s.hop;
      hang.rotation.x = -pole.rotation.x - torso.rotation.x + sin(s.stride) * 0.32 * s.move + sin(s.t * 1.5) * 0.06;
      hang.rotation.z = sin(s.t * 1.2) * 0.05 + sin(s.stride + 1) * 0.1 * s.move;
      light.flare(s.cheer * 1.2);
    },
  };
}

function keeper(root) {
  const main = flat(0xffffff, { side: THREE.DoubleSide });
  const deep = flat(0xffffff, { side: THREE.DoubleSide });
  const ink = flat(INK);
  const body = group(root);

  // Every other point of the hem is drawn up, so it hangs ragged.
  const points = [[0.002, 1.1], [0.1, 1.07], [0.17, 0.95], [0.2, 0.74], [0.25, 0.47], [0.32, 0.22]];
  const robeGeometry = lathe(points, 14);
  const robe = robeGeometry.attributes.position;
  for (let i = 1; i <= 14; i += 2) {
    const at = i * points.length + points.length - 1;
    robe.setXYZ(at, robe.getX(at) * 0.86, robe.getY(at) + 0.13, robe.getZ(at) * 0.86);
  }
  const sway = hem(robeGeometry, 0.6, 0.26);
  body.add(mesh(robeGeometry, main));

  const mask = group(body, 0, 0.93, 0.13);
  mask.add(mesh(new THREE.IcosahedronGeometry(0.14, 2).scale(0.8, 1.1, 0.42), flat(PALE)));
  for (const side of [-1, 1]) {
    const slit = mesh(new THREE.BoxGeometry(0.058, 0.013, 0.02), ink, side * 0.05, 0.012, 0.052);
    slit.rotation.z = side * 0.2;
    mask.add(slit);
  }
  const jewel = lit(new THREE.OctahedronGeometry(0.02, 0), 0, 0.09, 0.05);
  mask.add(jewel);

  const ring = lit(new THREE.TorusGeometry(0.27, 0.008, 5, 44), 0, 0.99, -0.15);
  body.add(ring);
  const ringGlow = halo(ring, 0.95, 0.22);

  const sleeves = [-1, 1].map((side) => {
    const pivot = group(body, side * 0.17, 0.86, 0);
    pivot.add(mesh(new THREE.ConeGeometry(0.085, 0.44, 5, 1, true).translate(0, -0.22, 0), deep));
    pivot.rotation.z = side * 0.3;
    return pivot;
  });

  const shards = [0, 1, 2].map(() => {
    const shard = lit(new THREE.OctahedronGeometry(0.05, 0).scale(0.7, 1.5, 0.7));
    halo(shard, 0.42, 0.5);
    root.add(shard);
    return shard;
  });
  let turn = 0;

  return {
    paint(color, gain) {
      main.color.copy(color);
      main.emissive.copy(color);
      deep.color.copy(color).multiplyScalar(0.62);
      const bright = color.clone().lerp(WHITE, 0.55).multiplyScalar(1.6 * gain);
      ring.material.color.copy(bright);
      jewel.material.color.copy(bright);
      ringGlow.material.color.copy(color);
      for (const shard of shards) {
        shard.material.color.copy(bright);
        shard.children[0].material.color.copy(color).lerp(WHITE, 0.2);
      }
    },
    update(s) {
      body.position.y = 0.16 + sin(s.t * 1.8) * 0.05 + 0.3 * s.hop;
      body.rotation.x = 0.3 * s.move;
      body.rotation.z = sin(s.t * 1.1) * 0.03;
      main.emissiveIntensity = 0.1 + s.cheer * 0.4 + s.flash;
      mask.rotation.y = sin(s.t * 0.6) * 0.3 * (1 - s.move);
      mask.rotation.x = -0.06 - 0.22 * s.move - 0.2 * s.hop;
      ring.rotation.z = s.t * 0.4;
      ring.scale.setScalar(1 + 0.25 * s.cheer);
      sway(s);
      sleeves.forEach((sleeve, i) => {
        sleeve.rotation.x = 0.85 * s.move + sin(s.t * 1.7 + i * 2) * 0.07 - 2.2 * s.hop;
      });
      turn += s.dt * (1.1 + 2.6 * s.move + 9 * s.cheer);
      shards.forEach((shard, i) => {
        const angle = turn + (i * TAU) / 3;
        const reach = 0.5 + 0.3 * s.hop;
        shard.position.set(cos(angle) * reach, 0.72 + sin(s.t * 1.7 + i * 2.1) * 0.12 + 0.3 * s.hop, sin(angle) * reach - 0.12 * s.move);
        shard.rotation.y = s.t * 2 + i;
      });
    },
  };
}

function fox(root) {
  const main = flat(0xffffff);
  const pale = flat(PALE);
  const ink = flat(INK);
  const cloth = flat(0xffffff, { side: THREE.DoubleSide, emissiveIntensity: 0.15 });
  const body = group(root, 0, 0.46, 0);

  // Deeper in the chest than at the hips.
  const trunkGeometry = new THREE.IcosahedronGeometry(0.2, 1).scale(0.74, 0.8, 1.9);
  const trunk = trunkGeometry.attributes.position;
  for (let i = 0; i < trunk.count; i += 1) {
    const k = 1 + 0.24 * (trunk.getZ(i) / 0.38);
    trunk.setXY(i, trunk.getX(i) * k, trunk.getY(i) * k);
  }
  body.add(mesh(trunkGeometry, main));
  body.add(mesh(new THREE.IcosahedronGeometry(0.13, 1).scale(0.78, 0.9, 0.6), pale, 0, -0.05, 0.31));
  body.add(mesh(new THREE.IcosahedronGeometry(0.12, 1).scale(0.9, 1.25, 0.95), main, 0, 0.1, 0.3));

  const head = group(body, 0, 0.2, 0.36);
  head.add(mesh(new THREE.IcosahedronGeometry(0.145, 1).scale(1, 0.9, 1.02), main, 0, 0.03, 0.04));
  head.add(mesh(new THREE.ConeGeometry(0.078, 0.21, 5).rotateX(PI / 2), pale, 0, -0.015, 0.21));
  head.add(mesh(new THREE.IcosahedronGeometry(0.022, 1), ink, 0, -0.012, 0.315));
  for (const side of [-1, 1]) {
    head.add(mesh(new THREE.IcosahedronGeometry(0.02, 1), ink, side * 0.082, 0.065, 0.14));
    head.add(mesh(new THREE.IcosahedronGeometry(0.07, 1).scale(0.6, 0.55, 0.75), pale, side * 0.092, -0.04, 0.1));
  }
  const ears = [-1, 1].map((side) => {
    const ear = group(head, side * 0.085, 0.12, -0.01);
    ear.add(mesh(new THREE.ConeGeometry(0.058, 0.19, 4).translate(0, 0.095, 0), main));
    ear.add(mesh(new THREE.ConeGeometry(0.03, 0.09, 4).translate(0, 0.165, 0), ink));
    ear.rotation.z = -side * 0.22;
    return ear;
  });

  const legs = [[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([side, end]) => {
    const upper = limb(body, 0.24, 0.056, 0.032, main, side * 0.1, -0.06, end * 0.23 + (end > 0 ? 0.02 : 0));
    const lower = limb(upper, 0.2, 0.03, 0.02, ink, 0, -0.22, 0);
    return { upper, lower, phase: side * end > 0 ? 0 : PI, end };
  });

  const tail = group(body, 0, 0.04, -0.33);
  const joints = [];
  let parent = tail;
  [0.085, 0.125, 0.13, 0.095].forEach((radius, i) => {
    const joint = group(parent, 0, 0, i ? -0.115 : 0);
    joint.add(mesh(new THREE.IcosahedronGeometry(1, 1).scale(radius, radius, 0.16), i === 3 ? pale : main, 0, 0, -0.08));
    joints.push(joint);
    parent = joint;
  });
  const tip = lit(new THREE.IcosahedronGeometry(0.035, 1), 0, 0, -0.23);
  parent.add(tip);
  const tipGlow = halo(tip, 0.6, 0.55);

  const scarf = new Ribbon(body, 11, 0.1, cloth);
  body.add(mesh(new THREE.TorusGeometry(0.105, 0.028, 4, 9).rotateX(PI / 2 - 0.5), cloth, 0, 0.13, 0.3));

  return {
    paint(color, gain) {
      main.color.copy(color);
      main.emissive.copy(color);
      cloth.color.copy(color).lerp(WHITE, 0.6);
      cloth.emissive.copy(cloth.color);
      tip.material.color.copy(color).lerp(WHITE, 0.5).multiplyScalar(1.7 * gain);
      tipGlow.material.color.copy(color).lerp(WHITE, 0.2);
    },
    update(s) {
      const stride = s.stride * 1.25;
      body.position.y = 0.46 + abs(sin(stride)) * 0.045 * s.move + 0.42 * s.hop + sin(s.t * 1.8) * 0.004;
      body.rotation.x = sin(stride * 2 + 0.6) * 0.035 * s.move - 0.45 * s.hop;
      main.emissiveIntensity = 0.08 + s.cheer * 0.4 + s.flash;
      for (const { upper, lower, phase, end } of legs) {
        const a = stride + phase;
        upper.rotation.x = -sin(a) * 0.75 * s.move + (end > 0 ? -0.9 : 0.8) * s.hop;
        lower.rotation.x = (end > 0 ? 1 : -1) * (max(0, cos(a)) * 0.9 * s.move + 0.6 * s.hop) + (end > 0 ? 0 : 0.12);
      }
      head.rotation.y = sin(s.t * 0.5) * 0.4 * (1 - s.move);
      head.rotation.z = sin(s.t * 0.37 + 1) * 0.12 * (1 - s.move);
      head.rotation.x = -0.05 + 0.12 * s.move + 0.3 * s.hop;
      ears[0].rotation.x = -(max(0, sin(s.t * 1.3)) ** 24) * 0.5 - 0.3 * s.move;
      ears[1].rotation.x = -(max(0, sin(s.t * 1.3 + 2.2)) ** 24) * 0.5 - 0.3 * s.move;
      tail.rotation.x = 0.55 - 0.42 * s.move + 0.3 * s.hop;
      joints.forEach((joint, i) => {
        joint.rotation.y = sin(s.t * (2 + 6 * s.move) - i * 0.9) * (0.2 + 0.05 * i);
        joint.rotation.x = i ? 0.16 - 0.1 * s.move : 0;
      });
      tipGlow.scale.setScalar(0.6 * (1 + s.cheer));
      scarf.stream(s, 0, 0.16, 0.2, 0.62, 0, 0.7);
    },
  };
}

function paperLantern(root) {
  const paper = flat(0xffffff);
  const fold = flat(PALE, { side: THREE.DoubleSide, emissive: PALE, emissiveIntensity: 0.3 });
  const cloth = flat(0xffffff, { side: THREE.DoubleSide, emissiveIntensity: 0.15 });
  const ink = flat(INK);
  const body = group(root);

  // Two stacked, twisted pyramids, like a paper lantern pulled open.
  const shell = group(body, 0, 0.84, 0);
  shell.add(mesh(new THREE.ConeGeometry(0.25, 0.3, 6).translate(0, 0.15, 0), paper));
  shell.add(mesh(new THREE.ConeGeometry(0.25, 0.42, 6).rotateX(PI).rotateY(PI / 6).translate(0, -0.21, 0), paper));
  shell.add(mesh(new THREE.CylinderGeometry(0.258, 0.258, 0.022, 6), ink));
  shell.add(mesh(new THREE.CylinderGeometry(0.04, 0.065, 0.06, 6), ink, 0, 0.3, 0));
  shell.add(mesh(new THREE.TorusGeometry(0.035, 0.008, 4, 10), ink, 0, 0.36, 0));
  shell.add(mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.06, 6), ink, 0, -0.43, 0));
  const mark = lit(new THREE.OctahedronGeometry(0.03, 0).scale(1, 1.6, 0.4), 0, 0.1, 0.165);
  shell.add(mark);
  const glow = halo(shell, 1.5, 0.42);

  const finGeometry = new THREE.BufferGeometry();
  finGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0.1, 0.03, 0, -0.12, 0.02, 0.3, -0.03, -0.12, 0, -0.12, 0.02, 0.19, -0.2, -0.15, 0.3, -0.03, -0.12], 3),
  );
  const fins = [-1, 1].map((side) => {
    const pivot = group(shell, side * 0.2, 0, 0);
    const fin = mesh(finGeometry, fold);
    fin.scale.x = side;
    pivot.add(fin);
    return pivot;
  });
  const tassels = [new Ribbon(body, 10, 0.07, cloth), new Ribbon(body, 9, 0.05, cloth), new Ribbon(body, 9, 0.05, cloth)];
  let glowGain = 1;

  return {
    paint(color, gain) {
      glowGain = gain;
      paper.color.copy(color);
      paper.emissive.copy(color);
      cloth.color.copy(color).lerp(WHITE, 0.6);
      cloth.emissive.copy(cloth.color);
      mark.material.color.copy(color).lerp(WHITE, 0.7).multiplyScalar(1.7 * gain);
      glow.material.color.copy(color).lerp(WHITE, 0.15);
    },
    update(s) {
      body.position.y = 0.2 + sin(s.t * 1.7) * 0.06 + 0.3 * s.hop;
      body.rotation.x = 0.42 * s.move;
      body.rotation.z = sin(s.t * 1.1) * 0.05;
      shell.rotation.y = sin(s.t * 0.6) * 0.25 * (1 - s.move) + (s.cheer > 0 ? (1 - s.cheer) ** 0.6 * TAU : 0);
      paper.emissiveIntensity = (0.55 + 1.1 * s.cheer + sin(s.t * 2.3) * 0.05) * glowGain + s.flash;
      glow.scale.setScalar(1.5 * (1 + 0.6 * s.cheer));
      fins.forEach((fin, i) => {
        const side = i ? 1 : -1;
        fin.rotation.z = side * (0.1 + sin(s.t * 2.4) * 0.32 * (1 - 0.7 * s.move) - 0.5 * s.hop);
        fin.rotation.y = -side * 0.75 * s.move;
      });
      tassels[0].stream(s, 0, 0.4, 0, 0.5, 0, 0.9);
      tassels[1].stream(s, -0.035, 0.4, 0, 0.38, 1.4, 0.9);
      tassels[2].stream(s, 0.035, 0.4, 0, 0.38, 2.8, 0.9);
    },
  };
}

function heron(root) {
  const main = flat(0xffffff);
  const deep = flat(0xffffff);
  const pale = flat(PALE);
  const ink = flat(INK);
  const body = group(root, 0, 0.8, 0);

  const trunk = group(body);
  trunk.rotation.x = -0.28;
  trunk.add(mesh(new THREE.IcosahedronGeometry(0.2, 1).scale(0.72, 0.8, 1.5), main));
  trunk.add(mesh(new THREE.IcosahedronGeometry(0.16, 1).scale(0.7, 0.7, 1.25), pale, 0, -0.055, 0.05));
  trunk.add(mesh(new THREE.ConeGeometry(0.085, 0.34, 4).rotateX(-PI / 2).scale(1, 0.45, 1), deep, 0, 0.02, -0.38));
  const wings = [-1, 1].map((side) => {
    const pivot = group(trunk, side * 0.12, 0.09, 0.12);
    pivot.add(mesh(new THREE.IcosahedronGeometry(0.2, 1).scale(0.16, 0.5, 1.3), deep, side * 0.035, -0.07, -0.2));
    return pivot;
  });

  // The neck is an S of three bones, and the head rides on top of it.
  const neck = [];
  let parent = group(body, 0, 0.08, 0.22);
  [[0.22, 0.05, 0.036], [0.2, 0.036, 0.03], [0.14, 0.03, 0.028]].forEach(([length, low, high], i) => {
    const bone = limb(parent, length, low, high, main, 0, i ? neck[i - 1].length : 0, 0, true);
    bone.length = length;
    neck.push(bone);
    parent = bone;
  });
  const head = group(parent, 0, 0.14, 0);
  head.add(mesh(new THREE.IcosahedronGeometry(0.07, 1).scale(0.9, 0.9, 1.25), main, 0, 0.02, 0.02));
  head.add(mesh(new THREE.ConeGeometry(0.03, 0.3, 4).rotateX(PI / 2), flat(STRAW), 0, 0.005, 0.22));
  for (const side of [-1, 1]) head.add(mesh(new THREE.IcosahedronGeometry(0.014, 1), ink, side * 0.052, 0.035, 0.06));
  const crest = [0.5, 0.95].map((tilt, i) => {
    const plume = lit(new THREE.ConeGeometry(0.014, 0.24 - i * 0.05, 4).translate(0, 0.12 - i * 0.025, 0), 0, 0.06, -0.03);
    plume.rotation.x = -tilt - 0.9;
    head.add(plume);
    return plume;
  });
  const crestGlow = halo(head, 0.55, 0.45);
  crestGlow.position.set(0, 0.1, -0.14);

  const legs = [-1, 1].map((side) => {
    const thigh = limb(body, 0.36, 0.03, 0.018, ink, side * 0.07, -0.1, -0.03);
    const shin = limb(thigh, 0.36, 0.018, 0.014, ink, 0, -0.36, 0);
    shin.add(mesh(new THREE.BoxGeometry(0.1, 0.02, 0.15), ink, 0, -0.36, 0.045));
    return { thigh, shin };
  });

  return {
    paint(color, gain) {
      main.color.copy(color);
      main.emissive.copy(color);
      deep.color.copy(color).multiplyScalar(0.6);
      for (const plume of crest) plume.material.color.copy(color).lerp(WHITE, 0.55).multiplyScalar(1.7 * gain);
      crestGlow.material.color.copy(color).lerp(WHITE, 0.2);
    },
    update(s) {
      body.position.y = 0.8 + (abs(cos(s.stride)) - 0.6) * 0.045 * s.move + 0.4 * s.hop;
      body.rotation.x = 0.1 * s.move - 0.2 * s.hop;
      main.emissiveIntensity = 0.08 + s.cheer * 0.4 + s.flash;
      legs.forEach(({ thigh, shin }, i) => {
        const phase = s.stride + i * PI;
        thigh.rotation.x = -0.32 - sin(phase) * 0.7 * s.move - 0.5 * s.hop;
        shin.rotation.x = 0.5 + max(0, cos(phase)) * 1.0 * s.move + 0.6 * s.hop;
      });
      // The head stays behind for a beat, then darts forward, the way wading birds walk.
      const dart = sin(s.stride * 2) * 0.2 * s.move;
      const idle = sin(s.t * 0.9) * 0.05;
      neck[0].rotation.x = 0.62 + dart + idle + 0.25 * s.move - 0.5 * s.hop;
      neck[1].rotation.x = -1.05 - dart * 1.4 - idle;
      neck[2].rotation.x = 0.55 + dart * 0.4 - 0.25 * s.move + 0.5 * s.hop;
      head.rotation.x = -neck[0].rotation.x - neck[1].rotation.x - neck[2].rotation.x - body.rotation.x + 0.06;
      head.rotation.y = sin(s.t * 0.55) * 0.5 * (1 - s.move);
      crest.forEach((plume, i) => {
        plume.rotation.x = -1.4 - i * 0.45 + sin(s.t * 2 + i) * 0.06 - 0.35 * s.move + 0.9 * s.cheer;
      });
      crestGlow.scale.setScalar(0.55 * (1 + s.cheer));
      wings.forEach((wing, i) => {
        const side = i ? 1 : -1;
        wing.rotation.z = side * (1.25 * s.hop + 0.04 * s.move);
        wing.rotation.y = side * 0.5 * s.hop;
      });
    },
  };
}

function cairn(root) {
  const main = flat(0xffffff, { roughness: 1 });
  const dark = flat(0xffffff, { roughness: 1 });
  const leaf = flat(0xffffff, { side: THREE.DoubleSide, emissiveIntensity: 0.6 });
  const body = group(root);

  const stones = [
    [new THREE.DodecahedronGeometry(0.3, 0).scale(1.1, 0.72, 1), 0.23],
    [new THREE.DodecahedronGeometry(0.235, 0).scale(1, 0.78, 0.95), 0.63],
    [new THREE.DodecahedronGeometry(0.16, 0).scale(1, 0.85, 1), 0.94],
  ].map(([geometry, y], i) => {
    const stone = group(body, 0, y, 0);
    stone.add(mesh(geometry.rotateY(i * 1.3), i === 1 ? main : dark));
    stone.rest = y;
    return stone;
  });
  // Light shows through the gaps between the stones.
  const cores = [0.44, 0.8].map((y) => {
    const core = lit(new THREE.IcosahedronGeometry(0.075, 1), 0, y, 0);
    core.rest = y;
    core.glow = halo(core, 0.75, 0.5);
    body.add(core);
    return core;
  });
  const eyes = [-1, 1].map((side) => {
    const eye = lit(new THREE.BoxGeometry(0.036, 0.062, 0.02), side * 0.075, 0.015, 0.2);
    stones[1].add(eye);
    return eye;
  });
  stones[2].add(mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.12, 4), flat(WOOD), 0, 0.18, 0));
  const leaves = [-1, 1].map((side) => {
    const blade = mesh(new THREE.ConeGeometry(0.035, 0.13, 3).scale(1, 1, 0.3).translate(0, 0.065, 0), leaf, 0, 0.23, 0);
    blade.rotation.z = -side * 0.9;
    stones[2].add(blade);
    return blade;
  });
  const hands = [-1, 1].map((side) => {
    const hand = mesh(new THREE.DodecahedronGeometry(0.085, 0), dark, side * 0.37, 0.5, 0.02);
    body.add(hand);
    return hand;
  });

  return {
    paint(color, gain) {
      main.color.copy(color).lerp(STONE, 0.1);
      main.emissive.copy(color);
      dark.color.copy(color).lerp(STONE, 0.18).multiplyScalar(0.7);
      dark.emissive.copy(color);
      leaf.color.copy(color).lerp(WHITE, 0.5);
      leaf.emissive.copy(leaf.color);
      const bright = color.clone().lerp(WHITE, 0.5).multiplyScalar(1.7 * gain);
      for (const core of cores) {
        core.material.color.copy(bright);
        core.glow.material.color.copy(color).lerp(WHITE, 0.15);
      }
      for (const eye of eyes) eye.material.color.copy(bright);
    },
    update(s) {
      const lift = 0.3 * s.hop;
      body.rotation.x = 0.13 * s.move;
      main.emissiveIntensity = dark.emissiveIntensity = 0.05 + s.cheer * 0.35 + s.flash;
      // Each stone lands a little after the one below it.
      stones.forEach((stone, i) => {
        stone.position.y = stone.rest + abs(sin(s.stride - i * 0.55)) * (0.06 + 0.035 * i) * s.move
          + sin(s.t * 1.7 + i * 1.2) * 0.012 * i + lift * (1 + 0.2 * i) + s.cheer * 0.09 * i;
        stone.position.z = -0.05 * i * s.move;
      });
      stones[0].rotation.y = sin(s.t * 0.5) * 0.12;
      stones[1].rotation.y = sin(s.t * 0.6) * 0.35 * (1 - s.move);
      stones[2].rotation.y = s.t * 0.3 + (s.cheer > 0 ? (1 - s.cheer) ** 0.6 * TAU : 0);
      stones[2].rotation.z = sin(s.stride) * 0.1 * s.move;
      cores.forEach((core, i) => {
        core.position.y = (stones[i].position.y + stones[i + 1].position.y) / 2 + 0.02;
        core.position.z = (stones[i].position.z + stones[i + 1].position.z) / 2;
        core.scale.setScalar(1 + sin(s.t * 3 + i * 2) * 0.08 + 0.5 * s.cheer);
        core.glow.scale.setScalar(0.75 * (1 + 0.6 * s.cheer));
      });
      const blink = s.t % 4.1 < 0.12 ? 0.1 : 1;
      for (const eye of eyes) eye.scale.set(1, blink, 1);
      leaves.forEach((blade, i) => {
        blade.rotation.x = sin(s.t * 2.2 + i) * 0.12 - 0.5 * s.move;
      });
      hands.forEach((hand, i) => {
        const side = i ? 1 : -1;
        hand.position.set(
          side * (0.37 + 0.05 * s.hop),
          0.5 + sin(s.t * 1.9 + i * 2) * 0.025 + abs(sin(s.stride + i * PI)) * 0.06 * s.move + 0.75 * s.hop,
          0.02 + sin(s.stride + i * PI) * 0.22 * s.move,
        );
        hand.rotation.set(s.t * 0.4 + i, s.t * 0.3, 0);
      });
    },
  };
}

const BUILDERS = [wanderer, pilgrim, lamplighter, keeper, fox, paperLantern, heron, cairn];

// How far up to look to frame each figure, and from how far back.
export const FRAMING = [[0.6, 4.3], [0.72, 4.7], [0.84, 5.3], [0.72, 4.7], [0.5, 4.2], [0.7, 4.6], [0.72, 5.0], [0.6, 4.4]];

// `gain` scales the lit parts and `halo` the painted glow around them: 1 on a plain
// renderer, less where bloom already spreads the light.
export function makeCharacter(index, { gain = 1, halo: strength = 1 } = {}) {
  mist = strength;
  const root = new THREE.Group();
  const figure = (BUILDERS[index] || BUILDERS[0])(root);
  return {
    root,
    update: figure.update,
    paint: (color) => figure.paint(color, gain),
    dispose() {
      root.traverse((part) => {
        if (part.geometry) part.geometry.dispose();
        if (part.material) part.material.dispose();
      });
    },
  };
}
