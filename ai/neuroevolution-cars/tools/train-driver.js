#!/usr/bin/env node
/* ==========================================================================
   Reproduces ai/neuroevolution-cars/pretrained.js (≈ 6 min on a laptop core).

   Domain-randomised neuroevolution: every generation is scored on 4 fresh
   random tracks (random width and curviness), so drivers cannot memorise a
   circuit. Every 10 generations the top genomes are validated on 30 fixed
   tracks and the best validated genome is kept. The result is reported on
   60 unseen test tracks.

   Usage: node ai/neuroevolution-cars/tools/train-driver.js [generations=300]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
global.LabMath = require('../../../shared/js/lab-math.js');
const E = require('../evo-core.js');

const GENS = Number(process.argv[2] || 300);
const POP = 90;
const TRACKS_PER_GEN = 4;
const topo = E.topology(8);
const opts = { topo, maxLaps: 3, timeLimit: 60, stallTime: 2.5 };
const rng = LabMath.makeRng(77);

const trackFor = (s) => {
  const r = LabMath.makeRng(s * 31 + 7);
  return E.makeTrack(s, { halfWidth: Math.round(r.uniform(23, 38)), wiggle: r.uniform(0.2, 0.7) });
};
const valTracks = [E.makeTrack(14), E.makeTrack(2), E.makeTrack(9), ...Array.from({ length: 27 }, (_, i) => trackFor(90000 + i))];
const testTracks = Array.from({ length: 60 }, (_, i) => trackFor(50000 + i));
function evaluate(genome, tracks) {
  let fin = 0;
  let lap = 0;
  let score = 0;
  for (const tr of tracks) {
    const [c] = E.runGeneration(tr, [genome], opts);
    score += c.fitness;
    if (c.finished) { fin++; lap += c.lapTime; }
  }
  return { fin, lap: lap / Math.max(1, fin), score: score / tracks.length };
}

let genomes = Array.from({ length: POP }, () => E.randomGenome(rng, topo));
let best = null;
const t0 = Date.now();
for (let gen = 1; gen <= GENS; gen++) {
  const tracks = Array.from({ length: TRACKS_PER_GEN }, (_, k) => trackFor(1000 + gen * TRACKS_PER_GEN + k));
  const score = new Float64Array(POP);
  for (const tr of tracks) E.runGeneration(tr, genomes, opts).forEach((c, i) => (score[i] += c.fitness / TRACKS_PER_GEN));
  const pop = genomes.map((g, i) => ({ genome: g, fitness: score[i] }));
  if (gen % 10 === 0) {
    for (const cand of pop.slice().sort((a, b) => b.fitness - a.fitness).slice(0, 3)) {
      const v = evaluate(cand.genome, valTracks);
      if (!best || v.score > best.v.score) best = { genome: Float64Array.from(cand.genome), v, gen };
    }
    console.log(`gen ${gen}: validation ${best.v.fin}/${valTracks.length} finished, mean lap ${best.v.lap.toFixed(2)} s (genome from gen ${best.gen}) · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  genomes = E.nextGeneration(pop, rng, { elite: 4, mutRate: 0.1, mutSigma: 0.3 });
}
const test = evaluate(best.genome, testTracks);
console.log(`test: finished ${test.fin}/${testTracks.length} unseen tracks, mean lap ${test.lap.toFixed(2)} s`);

const g = Array.from(best.genome, (v) => +v.toFixed(4));
const rows = [];
for (let i = 0; i < g.length; i += 10) rows.push('    ' + g.slice(i, i + 10).join(', ') + ',');
const out = `/* EvoDrive — a pre-trained driver (${topo.join('–')} network, ${g.length} weights).
   Evolved offline in Node.js for ${GENS} generations with domain randomisation (every generation scored on ${TRACKS_PER_GEN} random tracks), champion picked on ${valTracks.length} validation tracks; completes ${test.fin} of ${testTracks.length} unseen random tracks.
   Load it from the Champion panel, race against it, or seed a new population with it.
   Regenerate with: node ai/neuroevolution-cars/tools/train-driver.js */
window.EVO_PRETRAINED = {
  hidden: ${topo[1]},
  genome: [
${rows.join('\n')}
  ],
};
`;
fs.writeFileSync(path.join(__dirname, '..', 'pretrained.js'), out);
console.log('wrote pretrained.js');
