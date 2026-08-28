// deprecated stub self-check — just verifies the deprecation plugin loads
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
const api = { h, useState: (await import("react")).useState, useEffect: (await import("react")).useEffect, useRef: (await import("react")).useRef, settings: () => ({}), invoke: async () => {}, playSound: () => {} };
const { default: activate } = await import("./main.js");
const plugin = activate(api);
if (!plugin.info) throw new Error("FAIL deprecated stub: missing info");
console.log("tuya-curtains-control (deprecated stub): 1 checks passed — merged into tuya-lights-control");
