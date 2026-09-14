// Demo networks — each one exercises a different part of the engine.
// Built with the same edit ops the lab uses, so they are valid saved data.

import { emptyNetwork, addNode, addRoad, findRoad } from "./roadEdit.js";
import { makeSection } from "./roadCrossSection.js";

const sec = (road, preset, from) => {
  road.sections = road.sections || [];
  road.sections.push(makeSection(preset, from, `s${road.sections.length + 1}`, { oneWay: road.type === "highway" || road.type === "ramp" }));
};

function downtown() {
  const d = emptyNetwork("eu");
  const X = [-240, -110, 20, 150, 280], Z = [-190, -90, 10, 110, 210];
  const N = X.map((x) => Z.map((z) => addNode(d, x, z)));
  const rowType = ["local", "avenue", "local", "collector", "local"];
  const colType = ["local", "collector", "boulevard", "local", "local"];
  for (let j = 0; j < Z.length; j++) {
    for (let i = 0; i + 1 < X.length; i++) {
      const r = findRoad(d, addRoad(d, N[i][j], N[i + 1][j], rowType[j]));
      if (rowType[j] === "avenue") { sec(r, "leftPocket", "end"); sec(r, "leftPocket", "start"); sec(r, "parkingEnds", "end"); sec(r, "parkingEnds", "start"); }
      if (rowType[j] === "local") { sec(r, "parkingEnds", "end"); sec(r, "parkingEnds", "start"); }
    }
  }
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j + 1 < Z.length; j++) {
      const r = findRoad(d, addRoad(d, N[i][j], N[i][j + 1], colType[i]));
      if (colType[i] === "local") { sec(r, "parkingEnds", "end"); sec(r, "parkingEnds", "start"); }
    }
  }
  // A diagonal cutting the grid → 6-arm junctions and triangular blocks.
  addRoad(d, N[0][4], N[1][3], "collector");
  addRoad(d, N[1][3], N[2][2], "collector");
  // Curved crescent through the south-east blocks.
  const e1 = addNode(d, 390, 250);
  addRoad(d, N[4][4], e1, "local", [{ x: 350, z: 235, r: 30 }]);
  return d;
}

function roundabouts() {
  const d = emptyNetwork("eu");
  const c = addNode(d, 0, 0, { kind: "roundabout" });
  const n = addNode(d, 0, -260), s = addNode(d, 0, 260), e = addNode(d, 300, 0), w = addNode(d, -300, 0);
  addRoad(d, n, c, "avenue");
  addRoad(d, c, s, "avenue");
  addRoad(d, c, e, "collector", [{ x: 150, z: 20, r: 120 }]);
  addRoad(d, w, c, "local");
  const c2 = addNode(d, 300, 240, { kind: "roundabout", ring: { radius: 23, lanes: 1 } });
  addRoad(d, e, c2, "collector", [{ x: 330, z: 120, r: 80 }]);
  const a = addNode(d, 470, 180), b = addNode(d, 450, 380), f = addNode(d, 180, 400), g = addNode(d, 150, 230);
  addRoad(d, c2, a, "local");
  addRoad(d, c2, b, "local", [{ x: 380, z: 330, r: 40 }]);
  addRoad(d, c2, f, "alley");
  addRoad(d, g, c2, "local");
  addRoad(d, s, g, "local", [{ x: 60, z: 250, r: 60 }]);
  const dead = addNode(d, -170, 150);
  addRoad(d, w, dead, "local", [{ x: -260, z: 110, r: 40 }]);
  return d;
}

function interchange() {
  const d = emptyNetwork("eu");
  // Eastbound carriageway (drives on +Z side), westbound on −Z.
  const E0 = addNode(d, -760, 14), S1 = addNode(d, -330, 14), M1 = addNode(d, 330, 14), E3 = addNode(d, 760, 14);
  const W0 = addNode(d, 760, -14), S2 = addNode(d, 330, -14), M2 = addNode(d, -330, -14), W3 = addNode(d, -760, -14);
  const e0 = findRoad(d, addRoad(d, E0, S1, "highway"));
  sec(e0, "laneDrop", "end");
  const eMain = findRoad(d, addRoad(d, S1, M1, "highway"));
  // A vertical curve passes BELOW its VPI: 9.4 m VPI → ~7.5 m crest.
  eMain.profile = { mode: "design", vpis: [{ u: 0.5, y: 9.4, L: 260 }] };
  const e3 = findRoad(d, addRoad(d, M1, E3, "highway"));
  sec(e3, "laneDrop", "start");
  const w0 = findRoad(d, addRoad(d, W0, S2, "highway"));
  sec(w0, "laneDrop", "end");
  const wMain = findRoad(d, addRoad(d, S2, M2, "highway"));
  wMain.profile = { mode: "design", vpis: [{ u: 0.5, y: 9.4, L: 260 }] };
  const w3 = findRoad(d, addRoad(d, M2, W3, "highway"));
  sec(w3, "laneDrop", "start");
  for (const id of [S1, M1, S2, M2]) d.nodes.find((n) => n.id === id).kind = "split";

  // Crossing avenue with the two ramp terminals.
  const AN = addNode(d, 0, -470), J2 = addNode(d, 0, -110), J1 = addNode(d, 0, 110), AS = addNode(d, 0, 470);
  const av1 = findRoad(d, addRoad(d, AN, J2, "avenue"));
  const av2 = findRoad(d, addRoad(d, J2, J1, "avenue"));
  const av3 = findRoad(d, addRoad(d, J1, AS, "avenue"));
  // Left pockets only where left leads onto an on-ramp: southbound at J1,
  // northbound at J2 (the other lefts would face an off-ramp coming in).
  sec(av2, "leftPocket", "start"); sec(av2, "leftPocket", "end");
  for (const r of [av1, av2, av3]) { sec(r, "parkingEnds", "start"); sec(r, "parkingEnds", "end"); }
  addRoad(d, S1, J1, "ramp", [{ x: -180, z: 36, r: 260 }, { x: -80, z: 110, r: 85 }]);
  addRoad(d, J1, M1, "ramp", [{ x: 80, z: 110, r: 85 }, { x: 180, z: 36, r: 260 }]);
  addRoad(d, S2, J2, "ramp", [{ x: 180, z: -36, r: 260 }, { x: 80, z: -110, r: 85 }]);
  addRoad(d, J2, M2, "ramp", [{ x: -80, z: -110, r: 85 }, { x: -180, z: -36, r: 260 }]);
  return d;
}

function hillRoad() {
  const d = emptyNetwork("eu");
  d.terrain = "hills";
  const a = addNode(d, -900, -60), t = addNode(d, -40, 40), b = addNode(d, 900, 80);
  addRoad(d, a, t, "rural", [{ x: -620, z: -300, r: 250 }, { x: -300, z: -60, r: 250 }]);
  addRoad(d, t, b, "rural", [{ x: 280, z: 190, r: 250 }, { x: 620, z: -140, r: 240 }]);
  // A lane down the valley, meeting the rural road at a T.
  const v = addNode(d, 60, 420);
  addRoad(d, t, v, "local", [{ x: -20, z: 260, r: 90 }]);
  return d;
}

function oldTown() {
  const d = emptyNetwork("eu");
  const P = [
    [0, 0], [95, -18], [178, 22], [-72, 88], [36, 108], [140, 120], [230, 100],
    [-40, 200], [80, 215], [190, 230], [-150, 20], [-110, -110], [40, -130], [160, -120],
  ];
  const n = P.map(([x, z]) => addNode(d, x, z));
  const E = [
    [0, 1, "local"], [1, 2, "local"], [0, 3, "alley"], [0, 4, "local"], [1, 4, "alley"], [1, 5, "alley"],
    [2, 5, "local"], [2, 6, "local"], [3, 4, "alley"], [4, 5, "local"], [5, 6, "alley"], [3, 7, "local"],
    [4, 8, "alley"], [5, 9, "local"], [7, 8, "local"], [8, 9, "alley"], [0, 10, "collector"], [10, 11, "collector"],
    [0, 12, "local"], [12, 13, "local"], [1, 12, "alley"], [11, 12, "local"], [13, 2, "local"], [3, 10, "alley"],
  ];
  for (const [i, j, t] of E) {
    const ax = P[i][0], az = P[i][1], bx = P[j][0], bz = P[j][1];
    const mx = (ax + bx) / 2 + (bz - az) * 0.12, mz = (az + bz) / 2 - (bx - ax) * 0.12;
    addRoad(d, n[i], n[j], t, Math.hypot(bx - ax, bz - az) > 90 ? [{ x: mx, z: mz, r: 60 }] : []);
  }
  const cul = addNode(d, 300, 180);
  addRoad(d, n[6], cul, "alley", [{ x: 280, z: 130, r: 25 }]);
  return d;
}

function boulevard() {
  const d = emptyNetwork("us");
  const w = addNode(d, -420, 0), j1 = addNode(d, -140, 0), j2 = addNode(d, 150, 0), e = addNode(d, 430, 0);
  const b1 = findRoad(d, addRoad(d, w, j1, "boulevard"));
  const b2 = findRoad(d, addRoad(d, j1, j2, "boulevard"));
  const b3 = findRoad(d, addRoad(d, j2, e, "boulevard", [{ x: 300, z: 30, r: 400 }]));
  for (const r of [b1, b2, b3]) {
    r.sections = [];
    r.sections.push({ id: "m1", kind: "leftPocket", from: "end", d: 45, taper: 25, ops: [{ op: "center", width: 1.4 }, { op: "add", side: "right", at: "inner", lane: { type: "turn", width: 3.2, turn: "left" } }] });
    r.sections.push({ id: "m2", kind: "leftPocket", from: "start", d: 45, taper: 25, ops: [{ op: "center", width: 1.4 }, { op: "add", side: "left", at: "inner", lane: { type: "turn", width: 3.2, turn: "left" } }] });
  }
  const n1 = addNode(d, -140, -260), s1 = addNode(d, -140, 250);
  const n2 = addNode(d, 150, -250), s2 = addNode(d, 150, 260);
  const a1 = findRoad(d, addRoad(d, n1, j1, "avenue"));
  const a2 = findRoad(d, addRoad(d, j1, s1, "avenue"));
  sec(a1, "leftPocket", "end"); sec(a1, "rightPocket", "end"); sec(a1, "parkingEnds", "end");
  sec(a2, "leftPocket", "start"); sec(a2, "parkingEnds", "start");
  addRoad(d, j2, n2, "oneWay");
  const c = findRoad(d, addRoad(d, j2, s2, "collector"));
  sec(c, "bulbOut", "start");
  return d;
}

export const SCENES = {
  downtown: { label: "Downtown grid", build: downtown },
  boulevard: { label: "Boulevard & pockets", build: boulevard },
  roundabouts: { label: "Roundabouts", build: roundabouts },
  interchange: { label: "Diamond interchange", build: interchange },
  oldTown: { label: "Old town", build: oldTown },
  hillRoad: { label: "Hill road", build: hillRoad },
};
