/**
 * Headless checks for the sprint-course runner (start_new → CP* → finish_new).
 *
 *   node tools/sprintRunTest.mjs
 */
import * as THREE from "three";
import { RunTracker, formatRunTime } from "../games/modular-road-v3/modularRoadRun.js";

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const DT = 1 / 120;
const velFwd = new THREE.Vector3(0, 0, -20); // along typical piece travel (−Z)

/** Piece travelling −Z from z0 to z1 (entry at z0, more-negative z1). */
function piece(id, chainId, z0, z1, hw = 8) {
  return {
    id,
    chainId,
    hw,
    pp: {},
    connectorIn: new THREE.Matrix4().setPosition(0, 0, z0),
    connectorOut: new THREE.Matrix4().setPosition(0, 0, z1),
  };
}

function driveThrough(run, gate, vel = velFwd) {
  const behind = gate.pos.clone().addScaledVector(gate.fwd, -2);
  const ahead = gate.pos.clone().addScaledVector(gate.fwd, 2);
  run.update(DT, behind, vel);
  return run.update(DT, ahead, vel);
}

{
  const run = new RunTracker();
  run.buildGates([piece("start_new", 0, 0, -20)]);
  check("start alone is not a course", !run.hasCourse);
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("start", 0, 0, -16),
    piece("finish", 0, -16, -32),
  ]);
  check("open start/finish do not make a sprint course", !run.hasCourse);
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("start_new", 0, 0, -20),
    piece("straight", 0, -20, -36),
    piece("finish_new", 0, -36, -56),
  ]);
  check("rounded start + finish is a course", run.hasCourse);
  check("no checkpoints", run.cpCount === 0);
  check("armed clock is 0", run.currentTime === 0 && !run.running);
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("start_new", 0, 0, -20),
    piece("checkpoint_new", 0, -20, -36),
    piece("finish_new", 0, -36, -56),
  ]);
  const start = run.gates[0];
  const cp = run.gates[1];
  const fin = run.gates[2];

  check("clock does not tick while armed", (() => {
    run.update(DT, start.pos.clone().addScaledVector(start.fwd, -4), velFwd);
    return run.currentTime === 0;
  })());

  const ev0 = driveThrough(run, start);
  check("crossing start starts the run", ev0?.kind === "start" && run.running);

  run.update(DT, start.pos.clone().addScaledVector(start.fwd, 4), velFwd);
  check("clock advances only while running", run.currentTime > 0);

  const evCp = driveThrough(run, cp);
  check("checkpoint fires in order", evCp?.kind === "checkpoint");

  const tAtCp = run.currentTime;
  const evFin = driveThrough(run, fin);
  check("finish stops the clock", evFin?.kind === "finish" && run.finished && !run.running);
  check("finish time is a record", evFin.isRecord === true);
  check("best is stored", run.bestTime === evFin.time);
  const frozen = run.currentTime;
  run.update(DT, fin.pos.clone().addScaledVector(fin.fwd, 6), velFwd);
  check("clock stays frozen after finish", run.currentTime === frozen);
  check("finish is after the checkpoint", frozen >= tAtCp);
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("start_new", 0, 0, -20),
    piece("checkpoint_new", 0, -20, -36),
    piece("finish_new", 0, -36, -56),
  ]);
  driveThrough(run, run.gates[0]);
  const ev = driveThrough(run, run.gates[2]); // skip CP, hit finish
  check("finish is ignored until every CP is hit", ev === null && run.running && !run.finished);
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("start_new", 0, 0, -20),
    piece("finish_new", 1, -36, -56), // jump / new chain
  ]);
  check("finish on another chain is still a course", run.hasCourse);
  check("gates are start then finish", run.gates[0].role === "start" && run.gates[1].role === "finish");
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("finish_new", 1, -36, -56), // placed the landing first
    piece("start_new", 0, 0, -20),
    piece("checkpoint_new", 2, -20, -36),
  ]);
  check("finish placed before start still makes a course", run.hasCourse);
  check("drive order is start, CP, finish",
    run.gates[0].role === "start" && run.gates[1].role === "checkpoint" && run.gates[2].role === "finish");
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("start_new", 0, 0, -20),
    piece("finish_new", 0, -36, -56),
  ]);
  driveThrough(run, run.gates[0]);
  for (let i = 0; i < 24; i++) {
    run.update(DT, run.gates[0].pos.clone().addScaledVector(run.gates[0].fwd, 4), velFwd);
  }
  const live = run.currentTime;
  check("sim dt is what the clock sums", Math.abs(live - 24 * DT) < 1e-9, `${live}`);
  driveThrough(run, run.gates[1]);
  const ev = driveThrough(run, run.gates[0]); // retry through start
  check("re-crossing start after finish starts a new run", ev?.kind === "start" && run.running && !run.finished);
  check("retry clock is 0", run.currentTime === 0);
}

{
  const run = new RunTracker();
  run.buildGates([
    piece("start_new", 0, 0, -20),
    piece("finish_new", 0, -36, -56),
  ]);
  driveThrough(run, run.gates[0]);
  for (let i = 0; i < 12; i++) {
    run.update(DT, run.gates[0].pos.clone().addScaledVector(run.gates[0].fwd, 4), velFwd);
  }
  const first = driveThrough(run, run.gates[1]);
  check("first finish is a record with no delta", first.isRecord && !Number.isFinite(first.delta) && run.finishIsRecord);
  driveThrough(run, run.gates[0]);
  for (let i = 0; i < 24; i++) {
    run.update(DT, run.gates[0].pos.clone().addScaledVector(run.gates[0].fwd, 4), velFwd);
  }
  const slower = driveThrough(run, run.gates[1]);
  check("slower finish is not a record and has a +delta", !slower.isRecord && slower.delta > 0);
}

{
  check("format under a minute", formatRunTime(5.123) === "05.123");
  check("format with minutes", formatRunTime(65.5) === "1:05.500");
  check("format of NaN", formatRunTime(NaN) === "--:--.---");
}

if (fail) {
  console.error(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nall passed");
