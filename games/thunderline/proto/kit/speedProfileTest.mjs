// speedProfile.js — the builder's realistic take-off speed (the white arc). Guards:
//   - a flight that comes down on the very next point ENDS (it once never did: the physics lab froze on load)
//   - on a flat straight the car speeds up from rest, and never past the engine's top
//   - a jump keeps only the speed ALONG the landing: a drop onto flat ground is not speed gained
import * as THREE from "three";
import { speedProfile, profileCar } from "./speedProfile.js";

let fails = 0;
const fail = (m) => { fails++; console.log("FAIL", m); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const car = profileCar("arcade");
const straight = (n, z0 = 0, y = 0, uid = 1) => Array.from({ length: n }, (_, k) => ({ P: V(0, y, z0 - k * 4), T: V(0, 0, -1), U: V(0, 1, 0), uid }));

// 1. a "flight" landing on the next point terminates
{
  const ride = [...straight(2, 0, 0, 1), ...straight(2, -8, 0, 2)];
  const t = Date.now();
  const v = speedProfile(ride, car, 10, (i) => i === 1);
  if (Date.now() - t > 200 || v.length !== 4) fail(`next-point flight: ${Date.now() - t} ms, ${v.length} speeds`);
}
// 2. a flat 800 m straight from rest
{
  const v = speedProfile(straight(200), car, 0);
  if (!(v[50] > v[10] && v[10] > 0)) fail(`no acceleration on the flat: ${v[10]} → ${v[50]}`);
  if (v[199] > car.top + 0.01) fail(`over the top speed: ${v[199]} > ${car.top}`);
}
// 3. off a 20° lip 10 m up, onto flat ground: the landing speed is the horizontal part (less drag), not more
{
  const lipT = V(0, Math.sin(20 * Math.PI / 180), -Math.cos(20 * Math.PI / 180));
  const ride = [{ P: V(0, 10, 0), T: lipT, U: V(0, 1, 0), uid: 1 }, ...straight(80, -40, 0, 2)];
  const v = speedProfile(ride, car, 50, (i) => i === 0);
  const land = v.findIndex((s, i) => i > 0 && s > 0);
  const horiz = 50 * Math.cos(20 * Math.PI / 180);
  if (!(v[land] <= horiz + 0.01 && v[land] > horiz * 0.85)) fail(`landing speed ${v[land].toFixed(1)} m/s, the horizontal part is ${horiz.toFixed(1)}`);
}
console.log(fails ? `${fails} failure(s)` : "speedProfile: all good");
process.exitCode = fails ? 1 : 0;
