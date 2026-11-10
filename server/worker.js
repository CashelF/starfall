import { DurableObject } from "cloudflare:workers";
import {
  CATCH,
  CHARACTERS,
  COLORS,
  FALL_MS,
  METEOR_COST,
  METEOR_R,
  METEOR_WARN_MS,
  R,
  RESULTS_MS,
  ROUND_MS,
  SPEED,
  STAR_LIFE,
  STAR_POINTS,
  STUN_MS,
  SWARM_MS,
  arc,
  normalize,
  toward,
} from "../shared.js";

const TICK_MS = 100;
const MAX_HUMANS = 8;
// Rooms are billed while a socket is open, so quiet players are let go.
const IDLE_MS = 90000;
const HELLO_MS = 5000;
const MAX_WATCHERS = 64;
const MAX_MESSAGES_PER_SECOND = 60;
const BOT_COLOR = COLORS.length - 1;
// Slower than a person (SPEED), so a player who keeps moving still wins. `rest` is the
// breather after each catch, in ms, `wary` is how often they notice a meteor, and `ch`
// is the figure they wear until a person asks for it.
const BOTS = [
  { name: "Marvin", ch: 0, speed: 4.1, rest: [350, 900], wary: 0.75 },
  { name: "Trillian", ch: 7, speed: 4.7, rest: [200, 600], wary: 0.9 },
];
const ORIGIN = /^https:\/\/(www\.)?cashel\.dev$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ROOM_PATH = /^\/r\/([a-z0-9-]{1,24})$/;

const rand = (min, max) => min + Math.random() * (max - min);
const tidy = (v) => v.map((value) => Number(value.toFixed(4)));

function anywhere() {
  const z = rand(-1, 1);
  const angle = rand(0, Math.PI * 2);
  const ring = Math.sqrt(1 - z * z);
  return [ring * Math.cos(angle), ring * Math.sin(angle), z];
}

// A position within `distance` of the given one.
function near(position, distance) {
  const offset = anywhere();
  const reach = Math.tan(rand(0, distance) / R);
  return normalize([
    position[0] + offset[0] * reach,
    position[1] + offset[1] * reach,
    position[2] + offset[2] * reach,
  ]);
}

export default {
  async fetch(request, env) {
    const match = new URL(request.url).pathname.match(ROOM_PATH);
    if (!match) return new Response("starfall\n");
    const origin = request.headers.get("Origin") || "";
    // DEV_ANY_ORIGIN is only ever set by `wrangler dev --var`, to play from another device.
    if (!env.DEV_ANY_ORIGIN && !ORIGIN.test(origin)) {
      return new Response("Forbidden.\n", { status: 403 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket.\n", { status: 426 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  },
};

export class Room extends DurableObject {
  players = new Map();
  stars = new Map();
  meteors = new Map();
  sockets = new Map();
  nextPlayerId = 1;
  nextThingId = 1;
  timer = null;
  phase = "play";
  endsAt = 0;
  round = 0;
  nextStar = 0;
  nextMeteor = 0;
  lastTick = 0;

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    // Someone on the start screen, who is told at once when a figure or colour is taken.
    // These sockets can sleep, so an empty room with onlookers costs nothing to keep.
    if (new URL(request.url).searchParams.has("watch")) {
      if (this.ctx.getWebSockets("watch").length >= MAX_WATCHERS) {
        return new Response("Busy.\n", { status: 503 });
      }
      this.ctx.acceptWebSocket(server, ["watch"]);
      server.send(this.lobby());
      return new Response(null, { status: 101, webSocket: client });
    }
    server.accept();
    if (this.humans() >= MAX_HUMANS) {
      server.close(4002, "full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const session = { player: null, windowStart: 0, messages: 0 };
    this.sockets.set(server, session);
    setTimeout(() => {
      if (!session.player) this.drop(server, 4001, "idle");
    }, HELLO_MS);
    server.addEventListener("message", (event) => this.receive(server, session, event.data));
    server.addEventListener("close", () => this.drop(server));
    server.addEventListener("error", () => this.drop(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  humans() {
    let count = 0;
    for (const player of this.players.values()) if (!player.bot) count += 1;
    return count;
  }

  lobby() {
    return JSON.stringify({ c: [...this.held("c")], ch: [...this.held("ch")] });
  }

  announce() {
    const text = this.lobby();
    for (const socket of this.ctx.getWebSockets("watch")) {
      try {
        socket.send(text);
      } catch (error) {
        // It closes itself.
      }
    }
  }

  // Onlookers have nothing to say; these two are called for their sleeping sockets.
  webSocketMessage() {}

  webSocketClose(socket) {
    try {
      socket.close();
    } catch (error) {
      // Already closed.
    }
  }

  // What people (not robots) other than `except` are using of a colour or figure.
  held(field, except) {
    const held = new Set();
    for (const player of this.players.values()) {
      if (!player.bot && player !== except) held.add(player[field]);
    }
    return held;
  }

  // Gives a player the figure they asked for, or the next spare one. A person outranks a
  // robot, which then moves to a spare figure itself.
  dress(player, wanted) {
    const held = this.held("ch", player);
    const robots = new Map();
    for (const other of this.players.values()) {
      if (other.bot && other !== player) robots.set(other.ch, other);
    }
    const count = CHARACTERS.length;
    const spare = (free) => {
      for (let i = 0; i < count; i += 1) if (free((wanted + i) % count)) return (wanted + i) % count;
      return -1;
    };
    let ch = wanted;
    if (held.has(ch) || (player.bot && robots.has(ch))) {
      ch = spare((each) => !held.has(each) && !robots.has(each));
      if (ch < 0) ch = spare((each) => !held.has(each));
      if (ch < 0) ch = wanted;
    }
    player.ch = ch;
    const robot = robots.get(ch);
    if (!robot) return;
    this.dress(robot, robot.bot.ch);
    this.broadcast({ t: "look", id: robot.id, ch: robot.ch });
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.drop(socket);
    }
  }

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const [socket, session] of this.sockets) {
      if (!session.player) continue;
      try {
        socket.send(text);
      } catch (error) {
        this.drop(socket);
      }
    }
  }

  describe(player) {
    return {
      id: player.id,
      name: player.name,
      c: player.c,
      ch: player.ch,
      bot: Boolean(player.bot),
      score: player.score,
      d: tidy(player.d),
    };
  }

  addPlayer(name, c, ch, bot = null) {
    const player = {
      id: this.nextPlayerId++,
      name,
      c,
      ch: -1,
      bot,
      score: 0,
      d: anywhere(),
      moved: false,
      last: Date.now(),
      lastEmote: 0,
      stunnedUntil: 0,
      target: null,
      wander: anywhere(),
      thinkAt: 0,
      pauseUntil: 0,
      wary: true,
    };
    this.players.set(player.id, player);
    if (!bot) {
      // The colour they asked for, or the next one nobody is wearing.
      const worn = this.held("c", player);
      const colors = COLORS.length - 1;
      for (let i = 0; i < colors && worn.has(player.c); i += 1) player.c = (player.c + 1) % colors;
    }
    this.dress(player, ch);
    if (!bot) this.announce();
    return player;
  }

  removePlayer(player) {
    if (!this.players.delete(player.id)) return;
    this.broadcast({ t: "leave", id: player.id });
    if (!player.bot) this.announce();
  }

  // Robots keep a quiet room lively and step aside as people arrive.
  syncBots() {
    const humans = this.humans();
    const wanted = humans === 0 ? 0 : Math.max(0, 3 - humans);
    const bots = [...this.players.values()].filter((player) => player.bot);
    while (bots.length > wanted) this.removePlayer(bots.pop());
    for (const bot of BOTS) {
      if (bots.length >= wanted) break;
      if (bots.some((player) => player.bot === bot)) continue;
      const player = this.addPlayer(bot.name, BOT_COLOR, bot.ch, bot);
      bots.push(player);
      this.broadcast({ t: "join", p: this.describe(player) });
    }
  }

  drop(socket, code, reason) {
    const session = this.sockets.get(socket);
    if (!session) return;
    this.sockets.delete(socket);
    try {
      socket.close(code || 1000, reason || "bye");
    } catch (error) {
      // The socket was already closed.
    }
    if (session.player) {
      this.removePlayer(session.player);
      this.syncBots();
    }
    if (this.humans() === 0) this.stop();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.players.clear();
    this.stars.clear();
    this.meteors.clear();
  }

  receive(socket, session, data) {
    const now = Date.now();
    if (now - session.windowStart > 1000) {
      session.windowStart = now;
      session.messages = 0;
    }
    session.messages += 1;
    if (session.messages > MAX_MESSAGES_PER_SECOND) return this.drop(socket, 4003, "slow down");
    if (typeof data !== "string" || data.length > 300) return;
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      return;
    }
    if (!message || typeof message !== "object") return;
    const player = session.player;
    if (message.t === "ping") {
      this.send(socket, { t: "pong", c: Number(message.c) || 0, now });
    } else if (message.t === "hi" && !player) {
      this.welcome(socket, session, message, now);
    } else if (!player) {
      return;
    } else if (message.t === "p") {
      const d = Array.isArray(message.d) ? message.d.slice(0, 3).map(Number) : [];
      if (d.length !== 3 || !d.every(Number.isFinite) || Math.hypot(...d) < 0.5) return;
      if (now < player.stunnedUntil) return;
      // Nobody outruns their own legs, with some slack for bunched-up packets.
      const reach = (SPEED * 1.4 * Math.min(1000, now - player.last)) / 1000 + 0.6;
      player.d = toward(player.d, normalize(d), reach);
      player.moved = true;
      player.last = now;
    } else if (message.t === "c") {
      player.last = now;
      const star = this.stars.get(message.id);
      if (!star || this.phase !== "play" || now < star.t0 + FALL_MS - 250) return;
      // Generous enough to forgive network delay on either side.
      if (arc(player.d, star.d) < CATCH + 2) this.award(player, star);
    } else if (message.t === "e") {
      player.last = now;
      if (now - player.lastEmote < 400) return;
      player.lastEmote = now;
      this.broadcast({ t: "e", id: player.id });
    }
  }

  welcome(socket, session, message, now) {
    if (this.humans() >= MAX_HUMANS) return this.drop(socket, 4002, "full");
    const name = String(message.name || "").replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 12) || "Wanderer";
    const c = Math.abs(Math.round(Number(message.c) || 0)) % (COLORS.length - 1);
    const ch = Math.abs(Math.round(Number(message.ch) || 0)) % CHARACTERS.length;
    const player = this.addPlayer(name, c, ch);
    if (!this.timer) {
      this.lastTick = now;
      this.startRound(now);
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }
    // Everyone else hears about the newcomer before the newcomer starts listening.
    this.broadcast({ t: "join", p: this.describe(player) });
    this.syncBots();
    session.player = player;
    this.send(socket, {
      t: "welcome",
      id: player.id,
      now,
      phase: this.phase,
      endsAt: this.endsAt,
      round: this.round,
      players: [...this.players.values()].map((each) => this.describe(each)),
      stars: [...this.stars.values()],
      meteors: [...this.meteors.values()],
    });
  }

  startRound(now) {
    this.phase = "play";
    this.round += 1;
    this.endsAt = now + ROUND_MS;
    this.nextStar = now + 400;
    this.nextMeteor = now + rand(7000, 10000);
    this.stars.clear();
    this.meteors.clear();
    for (const player of this.players.values()) player.score = 0;
    this.broadcast({ t: "phase", phase: this.phase, endsAt: this.endsAt, round: this.round });
  }

  endRound(now) {
    this.phase = "results";
    this.endsAt = now + RESULTS_MS;
    this.stars.clear();
    this.meteors.clear();
    this.broadcast({ t: "phase", phase: this.phase, endsAt: this.endsAt, round: this.round });
  }

  award(player, star) {
    this.stars.delete(star.id);
    player.score += STAR_POINTS[star.k];
    this.broadcast({ t: "got", id: star.id, by: player.id, s: player.score });
  }

  addStar(now) {
    const star = { id: this.nextThingId++, k: Math.random() < 0.14 ? 1 : 0, t0: now, d: tidy(anywhere()) };
    this.stars.set(star.id, star);
    this.broadcast({ t: "star", f: star });
  }

  // Meteors aim near somebody, so there is always one worth watching for.
  addMeteor(now) {
    const players = [...this.players.values()];
    const aim = players[Math.floor(Math.random() * players.length)];
    const meteor = { id: this.nextThingId++, d: tidy(near(aim.d, 2.6)), at: now + METEOR_WARN_MS };
    this.meteors.set(meteor.id, meteor);
    for (const player of players) player.wary = Math.random() < (player.bot ? player.bot.wary : 0);
    this.broadcast({ t: "m", ...meteor });
  }

  strike(meteor, now) {
    this.meteors.delete(meteor.id);
    const struck = [];
    for (const player of this.players.values()) {
      if (arc(player.d, meteor.d) > METEOR_R) continue;
      player.score = Math.max(0, player.score - METEOR_COST);
      player.stunnedUntil = now + STUN_MS;
      player.pauseUntil = now + STUN_MS;
      struck.push([player.id, player.score]);
    }
    this.broadcast({ t: "hit", id: meteor.id, ps: struck });
  }

  // The most points for the least walking, leaving a star to a robot already nearer to it.
  chooseStar(bot) {
    let best = null;
    let bestWorth = 0;
    for (const star of this.stars.values()) {
      const distance = arc(bot.d, star.d);
      let worth = STAR_POINTS[star.k] / (distance + 1.5);
      for (const other of this.players.values()) {
        if (other !== bot && other.bot && other.target === star.id && arc(other.d, star.d) < distance) worth *= 0.25;
      }
      if (worth > bestWorth) {
        bestWorth = worth;
        best = star.id;
      }
    }
    return best;
  }

  moveBot(bot, now, dt) {
    if (now < bot.pauseUntil) return;
    let goal = null;
    if (bot.wary) {
      for (const meteor of this.meteors.values()) {
        if (arc(bot.d, meteor.d) > METEOR_R + 0.8) continue;
        // Straight away from where it will land.
        goal = normalize([
          bot.d[0] * 2 - meteor.d[0],
          bot.d[1] * 2 - meteor.d[1],
          bot.d[2] * 2 - meteor.d[2],
        ]);
      }
    }
    if (!goal) {
      if (now >= bot.thinkAt || !this.stars.has(bot.target)) {
        bot.thinkAt = now + rand(400, 800);
        bot.target = this.chooseStar(bot);
      }
      const star = this.stars.get(bot.target);
      // They head for a star while it is still falling, and wait under it.
      if (star && arc(bot.d, star.d) < CATCH) {
        if (now < star.t0 + FALL_MS) return;
        this.award(bot, star);
        bot.pauseUntil = now + rand(...bot.bot.rest);
        bot.thinkAt = 0;
        return;
      }
      if (!star && arc(bot.d, bot.wander) < 0.5) {
        bot.wander = near(bot.d, 9);
        bot.pauseUntil = now + rand(400, 1500);
        return;
      }
      goal = star ? star.d : bot.wander;
    }
    bot.d = toward(bot.d, goal, bot.bot.speed * dt);
    bot.moved = true;
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;

    for (const [socket, session] of this.sockets) {
      if (session.player && now - session.player.last > IDLE_MS) this.drop(socket, 4001, "idle");
    }
    if (!this.timer) return;

    if (now >= this.endsAt) {
      if (this.phase === "play") this.endRound(now);
      else this.startRound(now);
    }

    if (this.phase === "play") {
      for (const star of this.stars.values()) {
        if (now - star.t0 > STAR_LIFE[star.k]) this.stars.delete(star.id);
      }
      for (const meteor of this.meteors.values()) {
        if (now >= meteor.at) this.strike(meteor, now);
      }
      const count = this.players.size;
      const swarm = this.endsAt - now < SWARM_MS;
      const most = Math.min(22, 7 + 2 * count) + (swarm ? 10 : 0);
      if (now >= this.nextStar && this.stars.size < most) {
        this.addStar(now);
        this.nextStar = now + (rand(650, 950) / (0.7 + 0.3 * count)) * (swarm ? 0.3 : 1);
      }
      if (now >= this.nextMeteor && this.endsAt - now > METEOR_WARN_MS + 500) {
        this.addMeteor(now);
        this.nextMeteor = now + rand(5000, 8500) / (0.8 + 0.2 * count);
      }
    }

    const moved = [];
    for (const player of this.players.values()) {
      if (player.bot) this.moveBot(player, now, dt);
      if (!player.moved) continue;
      player.moved = false;
      moved.push([player.id, ...tidy(player.d)]);
    }
    if (moved.length) this.broadcast({ t: "s", ps: moved });
  }
}
