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
  room.award(hostId, others[1].id);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.player(others[1].id)!.score, 1);
  const reveal = room.viewFor(others[0].id);
  assert.equal(reveal.last!.word, 'ORANGE');
  assert.equal(reveal.last!.guesserId, others[1].id);
  assert.equal(reveal.letters, null);
  assert.equal(reveal.scores[room.player(others[1].id)!.team], 1);

  room.next(others[2].id);
  assert.equal(room.phase, 'choosing');
  assert.equal(room.round, 2);
});

test('host rotation is fair: everyone hosts once per cycle, no immediate repeats', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const { room, players } = roomWith(5, seed);
    room.start(players[0].id);
    const hosts: string[] = [room.hostId!];
    for (let r = 0; r < 14; r += 1) {
      room.pass(room.hostId!);
      hosts.push(room.hostId!);
    }
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const slice = hosts.slice(cycle * 5, cycle * 5 + 5);
      assert.equal(new Set(slice).size, 5, `seed ${seed} cycle ${cycle}`);
    }
    for (let i = 1; i < hosts.length; i += 1) assert.notEqual(hosts[i], hosts[i - 1]);
  }
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

test('switching and shuffling teams only between rounds', () => {
  const { room, players } = roomWith(4);
  const before = room.player(players[0].id)!.team;
  room.switchTeam(players[0].id);
  assert.notEqual(room.player(players[0].id)!.team, before);
  room.shuffleTeams(players[1].id);
  const ember = room.players.filter((p) => p.team === 'ember').length;
  assert.equal(ember, 2);
  room.start(players[0].id);
  throwsCode(() => room.switchTeam(players[0].id), 'wrong_phase');
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
