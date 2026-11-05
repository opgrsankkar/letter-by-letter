import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError, Registry, Room, type Deps } from '../src/server/game.ts';
import { cleanCode, cleanName, cleanWord, CODE_ALPHABET } from '../src/shared/protocol.ts';
import { CATEGORIES, drawWords } from '../src/shared/words.ts';

/** Deterministic deps: seeded PRNG, manual clock, counting secrets. */
function makeDeps(seed = 1): Deps & { advance: (ms: number) => void } {
  let s = seed;
  let now = 1_000_000;
  let n = 0;
  return {
    rand: () => {
      s = (s * 1664525 + 1013904223) % 2 ** 32;
      return s / 2 ** 32;
    },
    now: () => now,
    secret: () => `s${String(++n).padStart(6, "0")}-token-padding`,
    advance: (ms) => {
      now += ms;
    },
  };
}

function roomWith(count: number, seed = 1) {
  const deps = makeDeps(seed);
  const room = new Room('ACDE', deps);
  const players = Array.from({ length: count }, (_, i) => room.addPlayer(`P${i}`));
  return { room, players, deps };
}

/** Holders hint in the dealt order; hint everyone up to and including `id`. */
function hintThrough(room: Room, id?: string) {
  for (const pid of room.viewFor(room.hostId!).hintOrder) {
    room.markHinted(pid, true);
    if (pid === id) break;
  }
}

function throwsCode(fn: () => void, code: string) {
  assert.throws(fn, (err) => err instanceof GameError && err.code === code);
}

test('validation helpers', () => {
  assert.equal(cleanName('  Asha  '), 'Asha');
  assert.equal(cleanName('a\u0000b'), 'ab');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('x'.repeat(17)), null);
  assert.equal(cleanName(42), null);
  assert.equal(cleanWord("ice-cream"), 'ICECREAM');
  assert.equal(cleanWord('hot dog'), 'HOTDOG');
  assert.equal(cleanWord('ab'), null);
  assert.equal(cleanWord('café'), null);
  assert.equal(cleanWord('a'.repeat(21)), null);
  assert.equal(cleanCode(' acde '), 'ACDE');
  assert.equal(cleanCode('AC0E'), null);
  assert.equal(cleanCode('ACD'), null);
});

test('word deck is well formed', () => {
  for (const c of CATEGORIES) {
    assert.equal(new Set(c.words).size, c.words.length, `${c.id} has duplicates`);
    for (const w of c.words) assert.ok(cleanWord(w), `${w} must be a valid word`);
  }
  const drawn = drawWords('food', 3);
  assert.equal(new Set(drawn).size, 3);
  assert.equal(drawWords('nope', 3).length, 0);
});

test('teams stay balanced as players join', () => {
  const { room } = roomWith(7);
  const ember = room.players.filter((p) => p.team === 'ember').length;
  assert.ok(Math.abs(ember - (7 - ember)) <= 1);
});

test('names must be unique in a room and rooms cap at 10', () => {
  const { room } = roomWith(1);
  throwsCode(() => room.addPlayer('p0'), 'bad_name');
  // ...unless that player is away, in which case the newcomer takes the seat.
  const original = room.players[0];
  const oldToken = original.token;
  room.setConnected(original.id, false);
  const back = room.addPlayer('P0');
  assert.equal(back.id, original.id);
  assert.notEqual(back.token, oldToken);
  assert.equal(room.byToken(oldToken), undefined);
  for (let i = 1; i < 10; i += 1) room.addPlayer(`X${i}`);
  throwsCode(() => room.addPlayer('Eleven'), 'room_full');
});

test('cannot start with fewer than three connected players', () => {
  const { room, players } = roomWith(3);
  room.setConnected(players[2].id, false);
  throwsCode(() => room.start(players[0].id), 'too_few_players');
  room.setConnected(players[2].id, true);
  room.start(players[0].id);
  assert.equal(room.phase, 'choosing');
  assert.equal(room.round, 1);
  assert.ok(room.hostId);
});

test('a full round: deal, private views, award, reveal, next', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const hostId = room.hostId!;
  const others = players.filter((p) => p.id !== hostId);

  throwsCode(() => room.deal(others[0].id, 'ORANGE'), 'not_allowed');
  throwsCode(() => room.deal(hostId, 'x1'), 'bad_word');
  room.deal(hostId, 'orange');
  assert.equal(room.phase, 'playing');

  // Holders get letters, they add up to the word, nobody else sees it.
  const dealt: string[] = [];
  for (const p of others) {
    const v = room.viewFor(p.id);
    assert.ok(v.letters && v.letters.length >= 2, 'each of 3 holders gets 2 of 6 letters');
    assert.equal(v.word, null);
    assert.equal(v.holdings, null);
    assert.equal(v.players.find((x) => x.id === p.id)!.tileCount, v.letters.length);
    dealt.push(...v.letters);
  }
  assert.deepEqual(dealt.sort(), 'ORANGE'.split('').sort());
  const hostView = room.viewFor(hostId);
  assert.equal(hostView.word, 'ORANGE');
  assert.equal(hostView.letters, null);
  assert.equal(Object.keys(hostView.holdings!).length, 3);

  throwsCode(() => room.award(others[0].id, others[1].id), 'not_allowed');
  throwsCode(() => room.award(hostId, hostId), 'bad_request');
  hintThrough(room, others[1].id);
  room.award(hostId, others[1].id);
  assert.equal(room.phase, 'reveal');
  // Guessed during the letter stage: 2 for the guesser, 1 for the clue-giver.
  assert.equal(room.player(others[1].id)!.score, 2);
  assert.equal(room.player(hostId)!.score, 1);
  const reveal = room.viewFor(others[0].id);
  assert.equal(reveal.last!.word, 'ORANGE');
  assert.equal(reveal.last!.guesserId, others[1].id);
  assert.equal(reveal.last!.stage, 'letters');
  assert.deepEqual(reveal.last!.points, { [others[1].id]: 2, [hostId]: 1 });
  assert.equal(reveal.letters, null);
  assert.equal(reveal.scores.ember + reveal.scores.tide, 3);

  // Only the outgoing clue-giver (or the owner) moves the table on.
  const bystander = others.find((p) => p.id !== room.ownerId())!;
  throwsCode(() => room.next(bystander.id), 'not_allowed');
  room.next(hostId);
  assert.equal(room.phase, 'choosing');
  assert.equal(room.round, 2);
});

test('two stages: holders hint first; only the clue-giver opens the word clue', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  const holders = players.filter((p) => p.id !== host);
  room.deal(host, 'CACTUS');
  assert.equal(room.viewFor(holders[0].id).stage, 'letters');
  throwsCode(() => room.markHinted(host, true), 'not_allowed');
  hintThrough(room);
  assert.deepEqual(room.viewFor(host).hinted.sort(), holders.map((h) => h.id).sort());
  // Everyone hinting does not move the stage on by itself: a guess made in the
  // letter stage must not be downgraded because someone tapped "done" first.
  assert.equal(room.stage, 'letters');
  room.unlock(host);
  assert.equal(room.stage, 'clue');

  room.award(host, holders[0].id);
  assert.equal(room.player(holders[0].id)!.score, 1);
  assert.equal(room.player(host)!.score, 2, 'a word that needed the clue pays the clue-giver +2');
  assert.equal(room.last!.stage, 'clue');
  assert.deepEqual(room.viewFor(holders[0].id).hinted, []);
});

test('a letter-stage guess only earns +2 if the guesser had hinted their own letters', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'VOLCANO');
  const [early, late] = room.viewFor(host).hintOrder.map((id) => room.player(id)!);
  room.markHinted(early.id, true);
  room.award(host, late.id);
  assert.equal(room.player(late.id)!.score, 1, 'hinting last does not pay');
  assert.equal(room.last!.stage, 'letters');
  // The clue-giver can override from the reveal, including the stage.
  room.award(host, early.id, 'letters');
  assert.equal(room.player(late.id)!.score, 0);
  assert.equal(room.player(early.id)!.score, 2);
  room.award(host, early.id, 'clue');
  assert.equal(room.player(early.id)!.score, 1);
  assert.equal(room.last!.stage, 'clue');
  assert.equal(room.player(host)!.score, 2);
});

test('holders hint in the dealt order, and can only undo before the next player goes', () => {
  const { room, players } = roomWith(5);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'PINEAPPLE');
  const order = room.viewFor(host).hintOrder;
  assert.equal(order.length, 4);
  assert.deepEqual(room.pendingHinters(), order);
  throwsCode(() => room.markHinted(order[1], true), 'not_allowed');
  room.markHinted(order[0], true);
  room.markHinted(order[0], false);
  room.markHinted(order[0], true);
  room.markHinted(order[1], true);
  throwsCode(() => room.markHinted(order[0], false), 'not_allowed');
  // Someone away is skipped rather than holding the table up.
  room.setConnected(order[2], false);
  room.markHinted(order[3], true);
  assert.deepEqual(room.pendingHinters(), []);
});

test("opening the word clue early caps the clue-giver's reward", () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'GIRAFFE');
  room.unlock(host);
  assert.equal(room.viewFor(host).early, true);
  const guesser = players.find((p) => p.id !== host)!;
  room.award(host, guesser.id);
  assert.equal(room.player(guesser.id)!.score, 1);
  assert.equal(room.player(host)!.score, 1);
  assert.equal(room.last!.early, true);
});

test('a wrong credit can still be fixed after Next round, until the next deal', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'MEADOW');
  hintThrough(room);
  const [a, b] = players.filter((p) => p.id !== host);
  room.award(host, a.id);
  room.next(host);
  assert.equal(room.phase, 'choosing');
  room.award(host, b.id);
  assert.equal(room.player(a.id)!.score, 0);
  assert.equal(room.player(b.id)!.score, 2);
  room.deal(room.hostId!, 'TULIP');
  throwsCode(() => room.award(host, a.id), 'not_allowed');
});

test('the clue-giver can open the word clue early', () => {
  const { room, players } = roomWith(3);
  room.start(players[0].id);
  const host = room.hostId!;
  const holder = players.find((p) => p.id !== host)!;
  room.deal(host, 'TEAPOT');
  throwsCode(() => room.unlock(holder.id), 'not_allowed');
  room.unlock(host);
  assert.equal(room.viewFor(holder.id).stage, 'clue');
});

test('the clue-giver can correct who guessed during the reveal', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  const [a, b] = players.filter((p) => p.id !== host);
  room.deal(host, 'BEAVER');
  hintThrough(room, a.id);
  room.award(host, a.id);
  assert.equal(room.player(a.id)!.score, 2);
  throwsCode(() => room.award(a.id, b.id), 'not_allowed');
  room.award(host, b.id);
  assert.equal(room.player(a.id)!.score, 0);
  assert.equal(room.player(b.id)!.score, 2);
  assert.equal(room.player(host)!.score, 1);
  room.award(host, null);
  assert.deepEqual(
    room.players.map((p) => p.score),
    [0, 0, 0, 0],
  );
  assert.equal(room.last!.guesserId, null);
  // "Nobody" can be corrected too, at the stage the round had reached.
  room.award(host, b.id);
  assert.equal(room.player(b.id)!.score, 2);
  throwsCode(() => room.award(host, host), 'bad_request');
});

test('host rotation alternates teams and is fair within each team', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    for (const size of [4, 5, 6]) {
      const { room, players } = roomWith(size, seed);
      room.start(players[0].id);
      const hosts: string[] = [room.hostId!];
      for (let r = 0; r < 23; r += 1) {
        room.pass(room.hostId!);
        hosts.push(room.hostId!);
      }
      const teamOf = (id: string) => room.player(id)!.team;
      for (let i = 1; i < hosts.length; i += 1) {
        assert.notEqual(teamOf(hosts[i]), teamOf(hosts[i - 1]), `seed ${seed} size ${size} turn ${i}`);
        assert.notEqual(hosts[i], hosts[i - 1]);
      }
      // Within a team, everyone goes once before anyone goes twice.
      for (const team of ['ember', 'tide'] as const) {
        const members = room.players.filter((p) => p.team === team).length;
        const turns = hosts.filter((h) => teamOf(h) === team);
        for (let c = 0; c + members <= turns.length; c += members) {
          assert.equal(new Set(turns.slice(c, c + members)).size, members, `seed ${seed} ${team}`);
        }
      }
      // With balanced teams, everyone has given clues within the first lap.
      if (size % 2 === 0) assert.equal(new Set(hosts.slice(0, size)).size, size);
    }
  }
});

test('a one-sided table still rotates', () => {
  const { room, players } = roomWith(3);
  for (const p of players) p.team = 'ember';
  room.start(players[0].id);
  const hosts = [room.hostId!];
  for (let r = 0; r < 5; r += 1) {
    room.pass(room.hostId!);
    hosts.push(room.hostId!);
  }
  for (let i = 1; i < hosts.length; i += 1) assert.notEqual(hosts[i], hosts[i - 1]);
  assert.equal(new Set(hosts.slice(0, 3)).size, 3);
});

test('letters are spread evenly across holders', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  room.deal(room.hostId!, 'WATERFALL'); // 9 letters / 3 holders
  const counts = room.players.filter((p) => p.id !== room.hostId).map((p) => room.viewFor(p.id).letters!.length);
  assert.deepEqual(counts, [3, 3, 3]);
});

test('disconnected players are not dealt letters or picked as host', () => {
  const { room, players } = roomWith(5);
  room.setConnected(players[4].id, false);
  for (let i = 0; i < 6; i += 1) {
    if (room.phase === 'lobby') room.start(players[0].id);
    else room.pass(room.hostId!);
    assert.notEqual(room.hostId, players[4].id);
  }
  room.deal(room.hostId!, 'PLANET');
  assert.equal(room.viewFor(players[4].id).letters, null);
});

test('only the host may pass, unless the host has dropped off', () => {
  const { room, players } = roomWith(3);
  room.start(players[0].id);
  const host = room.hostId!;
  const other = players.find((p) => p.id !== host)!;
  throwsCode(() => room.pass(other.id), 'not_allowed');
  room.setConnected(host, false);
  // Only two connected players remain, so the room falls back to the lobby.
  room.pass(other.id);
  assert.equal(room.phase, 'lobby');
});

test('passing mid-round reveals the word with no points', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'COMET');
  room.pass(host);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.last!.word, 'COMET');
  assert.equal(room.last!.guesserId, null);
  assert.deepEqual(room.scores(), { ember: 0, tide: 0 });
});

test('a holder leaving mid-round hands their letters to the others', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'GALAXY');
  const leaver = players.find((p) => p.id !== host)!;
  room.removePlayer(leaver.id);
  assert.equal(room.phase, 'playing');
  const all = Object.values(room.viewFor(host).holdings!).flat();
  assert.deepEqual(all.sort(), 'GALAXY'.split('').sort());
  assert.equal(Object.keys(room.viewFor(host).holdings!).length, 2);
});

test('the host leaving mid-round reveals; leaving while choosing re-picks', () => {
  const { room, players } = roomWith(5);
  room.start(players[0].id);
  const firstHost = room.hostId!;
  room.removePlayer(firstHost);
  assert.equal(room.phase, 'choosing');
  assert.notEqual(room.hostId, firstHost);
  room.deal(room.hostId!, 'ROCKET');
  room.removePlayer(room.hostId!);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.last!.word, 'ROCKET');
});

test('next with too few players returns to the lobby instead of stalling', () => {
  const { room, players } = roomWith(3);
  room.start(players[0].id);
  room.deal(room.hostId!, 'TULIP');
  room.award(room.hostId!, null);
  room.setConnected(players[0].id, false);
  const stillHere = players.find((p) => p.id !== players[0].id)!;
  room.next(stillHere.id);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.hostId, null);
});

test('timer sets a deadline only while playing', () => {
  const { room, players, deps } = roomWith(3);
  throwsCode(() => room.setTimer(players[0].id, 45), 'bad_request');
  room.setTimer(players[0].id, 90);
  room.start(players[0].id);
  throwsCode(() => room.setTimer(players[0].id, 60), 'wrong_phase');
  room.deal(room.hostId!, 'STORM');
  assert.equal(room.viewFor(players[0].id).deadline, deps.now() + 90_000);
  room.award(room.hostId!, null);
  assert.equal(room.viewFor(players[0].id).deadline, null);
});

test('the owner runs the room; anyone can switch their own team in the lobby', () => {
  const { room, players } = roomWith(4);
  const [owner, guest] = players;
  assert.equal(room.ownerId(), owner.id);
  const before = room.player(guest.id)!.team;
  room.switchTeam(guest.id);
  assert.notEqual(room.player(guest.id)!.team, before);
  throwsCode(() => room.shuffleTeams(guest.id), 'not_allowed');
  throwsCode(() => room.setTimer(guest.id, 60), 'not_allowed');
  throwsCode(() => room.start(guest.id), 'not_allowed');
  room.shuffleTeams(owner.id);
  assert.equal(room.players.filter((p) => p.team === 'ember').length, 2);
  room.start(owner.id);
  throwsCode(() => room.switchTeam(guest.id), 'wrong_phase');
  throwsCode(() => room.shuffleTeams(owner.id), 'wrong_phase');

  // Ownership passes to the next player while the owner is away, and back.
  room.setConnected(owner.id, false);
  assert.equal(room.ownerId(), guest.id);
  room.setConnected(owner.id, true);
  assert.equal(room.ownerId(), owner.id);
});

test('ending the game shows final scores; a new game starts from zero', () => {
  const { room, players } = roomWith(3);
  const [owner] = players;
  room.start(owner.id);
  const host = room.hostId!;
  const guesser = players.find((p) => p.id !== host)!;
  room.deal(host, 'ACORN');
  hintThrough(room, guesser.id);
  room.award(host, guesser.id);
  const notOwner = players.find((p) => p.id !== owner.id)!;
  throwsCode(() => room.end(notOwner.id), 'not_allowed');
  room.end(owner.id);
  const v = room.viewFor(guesser.id);
  assert.equal(v.phase, 'lobby');
  assert.equal(v.ended, true);
  assert.equal(v.scores.ember + v.scores.tide, 3);
  assert.equal(v.last!.word, 'ACORN');

  room.start(owner.id);
  const fresh = room.viewFor(guesser.id);
  assert.equal(fresh.ended, false);
  assert.equal(fresh.round, 1);
  assert.equal(fresh.last, null);
  assert.deepEqual(fresh.scores, { ember: 0, tide: 0 });
});

test('registry: codes, resume, and sweeping', () => {
  const deps = makeDeps(7);
  const reg = new Registry(deps, { maxRooms: 3, abandonAfterMs: 60_000, awayAfterMs: 120_000 });
  const a = reg.create('Ann');
  assert.match(a.room.code, new RegExp(`^[${CODE_ALPHABET}]{4}$`));
  const b = reg.join(a.room.code, 'Ben');
  throwsCode(() => reg.join('XXXX', 'Cy'), 'not_found');
  assert.equal(reg.resume(a.room.code, b.player.token).player.id, b.player.id);
  throwsCode(() => reg.resume(a.room.code, 'nope'), 'not_found');
  reg.create('Two');
  reg.create('Three');
  throwsCode(() => reg.create('Four'), 'server_full');

  // Ben drifts away long enough to be dropped; Ann stays.
  a.room.setConnected(b.player.id, false);
  deps.advance(120_000);
  assert.deepEqual(reg.sweep().map((r) => r.code).includes(a.room.code), true);
  assert.equal(a.room.players.length, 1);

  // Everyone gone for the abandon window: room disappears.
  a.room.setConnected(a.player.id, false);
  deps.advance(59_000);
  reg.sweep();
  assert.ok(reg.rooms.has(a.room.code));
  deps.advance(2_000);
  reg.sweep();
  assert.ok(!reg.rooms.has(a.room.code));
});

// --- Findings from the gpt-6.1-sol review --------------------------------------

test('a short word at a big table: players without letters are not in the hint queue', () => {
  const { room, players } = roomWith(10);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'OWL');
  const order = room.viewFor(host).hintOrder;
  assert.equal(order.length, 3);
  for (const pid of order) assert.equal(room.viewFor(pid).letters!.length, 1);
  const spectator = players.find((p) => p.id !== host && !order.includes(p.id))!;
  assert.equal(room.viewFor(spectator.id).letters, null);
  hintThrough(room);
  assert.deepEqual(room.pendingHinters(), []);
  // Someone with nothing to hint gets the full letter-stage value.
  room.award(host, spectator.id);
  assert.equal(room.player(spectator.id)!.score, 2);
});

test('correcting credit never upgrades a guesser who had not hinted', () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'BADGER');
  const [first, , last] = room.viewFor(host).hintOrder;
  room.markHinted(first, true);
  room.award(host, last);
  assert.equal(room.player(last)!.score, 1);
  room.award(host, last, 'letters');
  assert.equal(room.player(last)!.score, 1, 'still +1: they had not hinted');
  room.award(host, first, 'letters');
  assert.equal(room.player(first)!.score, 2);
  assert.equal(room.player(last)!.score, 0);
});

test("leaving keeps a player's points with their team, and corrections still balance", () => {
  const { room, players } = roomWith(4);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'COMET');
  hintThrough(room);
  const scorer = room.player(players.find((p) => p.id !== host && p.id !== players[0].id)!.id)!;
  room.award(host, scorer.id);
  const before = room.scores();
  room.removePlayer(scorer.id);
  assert.deepEqual(room.scores(), before, 'team totals unchanged after leaving');
  // The clue-giver moves the credit to someone else: the leaver's points come off.
  const other = players.find((p) => p.id !== host && p.id !== scorer.id)!;
  room.award(host, other.id);
  const total = room.scores().ember + room.scores().tide;
  assert.equal(total, 2 + 1, 'one guesser (+2) plus the clue-giver (+1)');
});

test('letters handed on from someone who never hinted must be hinted again', () => {
  const { room, players } = roomWith(3);
  room.start(players[0].id);
  const host = room.hostId!;
  room.deal(host, 'TEAPOT');
  const [a, b] = room.viewFor(host).hintOrder;
  room.markHinted(a, true);
  room.removePlayer(b);
  assert.equal(room.viewFor(a).letters!.length, 6);
  assert.deepEqual(room.pendingHinters(), [a], 'the new letters still need hinting');
  // A holder who had hinted leaving does not reset anyone.
  const r2 = roomWith(4);
  r2.room.start(r2.players[0].id);
  const h2 = r2.room.hostId!;
  r2.room.deal(h2, 'TEAPOT');
  const [x, y] = r2.room.viewFor(h2).hintOrder;
  r2.room.markHinted(x, true);
  r2.room.markHinted(y, true);
  r2.room.removePlayer(y);
  assert.ok(!r2.room.pendingHinters().includes(x));
});
