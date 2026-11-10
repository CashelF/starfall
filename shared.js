// Rules shared by the browser client and the room server (server/worker.js).
export const R = 10;
export const SPEED = 6;
export const CATCH = 1.2;
export const ROUND_MS = 60000;
export const RESULTS_MS = 9000;
export const SWARM_MS = 10000;
// Indexed by star kind: 0 is a pale star, 1 is a golden one.
export const STAR_LIFE = [26000, 16000];
export const STAR_POINTS = [1, 3];
// A star is seen falling for this long before it can be picked up.
export const FALL_MS = 900;
export const METEOR_WARN_MS = 2600;
export const METEOR_R = 2.3;
export const METEOR_COST = 2;
export const STUN_MS = 1100;
// Cloak colours; the last one belongs to the robots.
export const COLORS = [0xe9765b, 0xe8b04a, 0x7fb69a, 0x3fa7a3, 0x6fa8dc, 0x7d7be0, 0xc487d4, 0xe58aa6, 0x9aa0b8];
// The figures a player can be, drawn in characters.js. No two people in a world share one.
export const CHARACTERS = ["Wanderer", "Pilgrim", "Lamplighter", "Keeper", "Fox", "Paper lantern", "Heron", "Cairn"];

// Positions are unit vectors from the planet's centre, as [x, y, z].
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

// Distance walked over the surface between two positions.
export function arc(a, b) {
  return R * Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
}

// The position reached by walking `distance` from a toward b.
export function toward(a, b, distance) {
  const total = arc(a, b);
  if (total <= distance) return b.slice();
  const angle = total / R;
  const sine = Math.sin(angle);
  if (sine < 1e-4) return a.slice();
  const t = distance / total;
  const ka = Math.sin((1 - t) * angle) / sine;
  const kb = Math.sin(t * angle) / sine;
  return normalize([a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]);
}
