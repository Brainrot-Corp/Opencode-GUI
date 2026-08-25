// runnable self-check: node src/lib/tuya.test.ts
import { brightVal, tempVal, colorData } from "./tuya.ts";

let n = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

// brightness: % → dp range (v2: 10..1000, v1: 25..255), clamped at both ends
eq(brightVal(50, true), 500, "v2 mid");
eq(brightVal(100, true), 1000, "v2 max");
eq(brightVal(1, true), 10, "v2 floor");
eq(brightVal(150, false), 255, "v1 clamp high");
eq(brightVal(0, false), 25, "v1 clamp low");

// temperature: warmth presets, v1 scaled down
eq(tempVal("warm", true), 880, "warm v2");
eq(tempVal("cool", true), 60, "cool v2");
eq(tempVal("warm", false), Math.round(880 * 0.255), "warm v1");
eq(tempVal("nonsense", true), 480, "unknown tone → neutral");

// colour_data packing: hex by default, JSON string when the device reports one
eq(colorData("red", true), "000003e803e8", "red v2 hex");
eq(colorData("blue", true), "00f003e803e8", "blue v2 hex");
eq(colorData("green", false), "007800ff00ff", "green v1 hex");
eq(
  colorData("blue", true, '{"h":16,"s":1000,"v":1000}'),
  '{"h":240,"s":1000,"v":1000}',
  "json-reporting device gets json back",
);

console.log(`tuya: ${n} checks passed`);
