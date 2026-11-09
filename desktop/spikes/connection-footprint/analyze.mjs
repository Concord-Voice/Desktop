// Summarise a raw-<platform>-<arch>.jsonl from main.mjs into markdown tables.
// Throwaway, like main.mjs. Usage (from desktop/):
//   node spikes/connection-footprint/analyze.mjs spikes/connection-footprint/results/raw-darwin-arm64.jsonl [--cores=18] [--prefix=prod-] [--exclude=prod-]
import fs from 'node:fs';
import os from 'node:os';

const [file, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
const CORES = Number(opt.cores ?? os.cpus().length);
const PREFIX = opt.prefix ?? '';
const EXCLUDE = opt.exclude ?? null;
const rows = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.run.startsWith(PREFIX) && !(EXCLUDE && r.run.startsWith(EXCLUDE)));

const runs = new Map();
for (const r of rows) {
  if (!runs.has(r.run)) runs.set(r.run, { id: r.run, loads: [], samples: [], probe: [], fp: [] });
  const run = runs.get(r.run);
  if (r.kind === 'run') run.meta = r;
  else if (r.kind === 'load') run.loads.push(r);
  else if (r.kind === 'sample') run.samples.push(r);
  else if (r.kind === 'probe') run.probe.push(r);
  else if (r.kind === 'footprint') run.fp.push(r);
  else if (r.kind === 'disk') run.disk = r.kb;
  else if (r.kind === 'visibility') run.vis = r.states;
}

const MB = (kb) => kb / 1024;
const f1 = (n) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(1));
const f2 = (n) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(2));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// One sample() call emits one line per process within a few ms: split rounds on a >1 s gap.
function rounds(run) {
  const out = [];
  for (const s of [...run.samples].sort((a, b) => a.t - b.t)) {
    const cur = out.at(-1);
    if (!cur || s.t - cur.t > 1000) out.push({ t: s.t, procs: [s] });
    else cur.procs.push(s);
  }
  return out;
}

function memOf(round) {
  const by = (pred) => round.procs.filter(pred).reduce((a, p) => a + p.wsKB, 0);
  return {
    total: by(() => true),
    browser: by((p) => p.type === 'Browser'),
    gpu: by((p) => p.type === 'GPU'),
    utility: by((p) => p.type === 'Utility'),
    tabs: by((p) => p.type === 'Tab'),
    perView: Object.fromEntries(round.procs.filter((p) => p.view != null).map((p) => [p.view, p.wsKB])),
  };
}

function summarise(run) {
  const m = run.meta;
  const rs = rounds(run);
  const durS = rs.length > 1 ? (rs.at(-1).t - rs[0].t) / 1000 : 0;
  const loadMax = run.loads.length ? Math.max(...run.loads.map((l) => l.ms)) : null;
  const atLoad = rs.length ? memOf(rs[0]) : null;
  const tail = rs.slice(-3).map(memOf);
  const steady = tail.length
    ? {
        total: mean(tail.map((x) => x.total)),
        browser: mean(tail.map((x) => x.browser)),
        gpu: mean(tail.map((x) => x.gpu)),
        utility: mean(tail.map((x) => x.utility)),
        tabs: mean(tail.map((x) => x.tabs)),
      }
    : null;
  // CPU from cumulativeCPUUsage over [first round >= +60 s, last round].
  let cpu = null;
  const startRound = rs.find((r) => r.t - rs[0].t >= 60_000);
  if (startRound && startRound !== rs.at(-1)) {
    const last = rs.at(-1);
    const span = (last.t - startRound.t) / 1000;
    cpu = { spanS: span, perView: {}, byType: {}, total: 0 };
    for (const p of last.procs) {
      const p0 = startRound.procs.find((q) => q.pid === p.pid);
      if (!p0 || p.cpuCumS == null || p0.cpuCumS == null) continue;
      const pct = ((p.cpuCumS - p0.cpuCumS) / span) * 100; // % of ONE core
      cpu.total += pct;
      if (p.view != null) cpu.perView[p.view] = pct;
      else cpu.byType[p.name ?? p.type] = (cpu.byType[p.name ?? p.type] ?? 0) + pct;
    }
  }
  const fpTotal = run.fp.length ? run.fp.reduce((a, x) => a + (x.bytes ?? 0), 0) / 1048576 : null;
  const fpView = Object.fromEntries(run.fp.filter((x) => x.view != null).map((x) => [x.view, x.bytes / 1048576]));
  return { m, rs, durS, loadMax, atLoad, steady, cpu, fpTotal, fpView };
}

const all = [...runs.values()].filter((r) => r.meta && r.meta.views != null).map((r) => ({ run: r, s: summarise(r) }));
const pick = (state, throttle, views) =>
  all.filter((x) => x.s.m.state === state && x.s.m.throttle === throttle && x.s.m.views === views);

const out = [];
const p = (s = '') => out.push(s);

p(`Source: \`${file}\`; CPU % is of ONE core (cumulativeCPUUsage delta / wall time); host has ${CORES} logical cores.`);
p();
p('### Cold start (state=cold, fresh profile; whenReady -> did-finish-load, median of reps)');
p();
p('| throttle | views | reps | per-view load ms (median) | all-loaded ms (median) | delta vs N-1 ms |');
p('|---|---|---|---|---|---|');
for (const th of [true, false]) {
  let prev = null;
  for (let v = 0; v <= 3; v++) {
    const xs = pick('cold', th, v);
    if (!xs.length) continue;
    const perView = [];
    for (let i = 0; i < v; i++) perView.push(median(xs.map((x) => x.run.loads.find((l) => l.view === i)?.ms ?? NaN)));
    const mx = v ? median(xs.map((x) => x.s.loadMax)) : 0;
    p(`| ${th} | ${v} | ${xs.length} | ${perView.map((n) => Math.round(n)).join(' / ') || '—'} | ${v ? Math.round(mx) : '—'} | ${prev == null ? '—' : Math.round(mx - prev)} |`);
    prev = mx;
  }
}
p();
p('### Memory: workingSetSize (MB), sum over every app process');
p();
p('`cold` = first sample at all-loaded (median of reps). `login-idle` = mean of the last 3 samples. Footprint = macOS phys_footprint at end of run (all processes; the private-memory cross-check).');
p();
p('| state | throttle | views | minutes (actual) | total WS | browser | GPU | utility | renderers (Tab) | delta total WS vs N-1 | footprint total | delta footprint vs N-1 | per-view renderer footprint |');
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const state of ['cold', 'login-idle']) {
  for (const th of [true, false]) {
    let prevWS = null;
    let prevFP = null;
    for (let v = 0; v <= 3; v++) {
      const xs = pick(state, th, v);
      if (!xs.length) continue;
      const mem = state === 'cold' ? xs.map((x) => x.s.atLoad) : xs.map((x) => x.s.steady);
      const med = (k) => median(mem.map((mm) => mm[k]));
      const tot = MB(med('total'));
      const fp = median(xs.map((x) => x.s.fpTotal));
      const pv = [];
      for (let i = 0; i < v; i++) pv.push(median(xs.map((x) => x.s.fpView[i] ?? NaN)));
      const mins = xs.map((x) => (x.s.durS / 60).toFixed(1)).join(',');
      p(
        `| ${state} | ${th} | ${v} | ${mins} | ${f1(tot)} | ${f1(MB(med('browser')))} | ${f1(MB(med('gpu')))} | ${f1(MB(med('utility')))} | ${f1(MB(med('tabs')))} | ${prevWS == null ? '—' : f1(tot - prevWS)} | ${f1(fp)} | ${prevFP == null ? '—' : f1(fp - prevFP)} | ${pv.map(f1).join(' / ') || '—'} |`
      );
      prevWS = tot;
      prevFP = fp;
    }
  }
}
p();
p('### Idle CPU (login-idle; window = +60 s after load to end of run), % of one core');
p();
p('| throttle | views | window s | view 0 (foreground) | hidden views 1..N-1 | browser | GPU | Network Service | total |');
p('|---|---|---|---|---|---|---|---|---|');
for (const th of [true, false]) {
  for (let v = 0; v <= 3; v++) {
    for (const x of pick('login-idle', th, v)) {
      const c = x.s.cpu;
      if (!c) continue;
      const hidden = [];
      for (let i = 1; i < v; i++) hidden.push(f2(c.perView[i]));
      p(
        `| ${th} | ${v} | ${Math.round(c.spanS)} | ${v ? f2(c.perView[0]) : '—'} | ${hidden.join(' / ') || '—'} | ${f2(c.byType.Browser)} | ${f2(c.byType.GPU)} | ${f2(c.byType['Network Service'])} | ${f2(c.total)} |`
      );
    }
  }
}
p();
p('### Heartbeat probe (login-idle). App heartbeat = 30 s setInterval in the page; server-measured gaps.');
p();
p('| throttle | views | view | visibility seen | hb count | max hb gap s | gaps > 45 s | gaps > 120 s (presence window) | max pong RTT ms | max app echo RTT ms |');
p('|---|---|---|---|---|---|---|---|---|---|');
for (const th of [true, false]) {
  for (let v = 1; v <= 3; v++) {
    for (const x of pick('login-idle', th, v)) {
      for (let i = 0; i < v; i++) {
        const ev = x.run.probe.filter((e) => e.view === i);
        const gaps = ev.filter((e) => e.ev === 'hb' && e.gapMs != null).map((e) => e.gapMs / 1000);
        const hbs = ev.filter((e) => e.ev === 'hb').length;
        const pong = ev.filter((e) => e.ev === 'pong').map((e) => e.rttMs);
        const echo = ev.filter((e) => e.ev === 'echo').map((e) => e.rttMs);
        const vis = [...new Set(ev.map((e) => e.vis).filter(Boolean))].join(',');
        p(
          `| ${th} | ${v} | ${i} | ${vis} | ${hbs} | ${gaps.length ? f1(Math.max(...gaps)) : '—'} | ${gaps.filter((g) => g > 45).length} | ${gaps.filter((g) => g > 120).length} | ${pong.length ? Math.max(...pong) : '—'} | ${echo.length ? Math.max(...echo) : '—'} |`
        );
      }
    }
  }
}
p();
p('### Heartbeat gap sequence (s), throttle=true views=3 hidden views');
p();
for (const x of pick('login-idle', true, 3).concat(pick('login-idle', false, 3))) {
  for (let i = 0; i < 3; i++) {
    const seq = x.run.probe
      .filter((e) => e.view === i && e.ev === 'hb')
      .map((e) => (e.gapMs == null ? `first@${Math.round(e.t / 1000)}s` : (e.gapMs / 1000).toFixed(1)));
    p(`- ${x.run.id} view ${i}: ${seq.join(', ')}`);
  }
}
p();
p('### session/ disk (du -sk, KB) at end of login-idle runs');
p();
p('| throttle | views | per view (view 0 = userData root minus spike/) |');
p('|---|---|---|');
for (const th of [true, false]) {
  for (let v = 1; v <= 3; v++) {
    for (const x of pick('login-idle', th, v)) {
      p(`| ${th} | ${v} | ${Object.values(x.run.disk ?? {}).join(' / ')} |`);
    }
  }
}
console.log(out.join('\n'));
