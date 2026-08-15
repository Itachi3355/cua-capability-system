import assert from "node:assert";
import { resolveDescriptor, scoreElement } from "../src/surface.js";
import type { ObservedElement, Snapshot } from "../src/types.js";

const el = (partial: Partial<ObservedElement>): ObservedElement => ({
  cuaId: "cua-0", role: "link", name: "", nearText: "", structuralPath: "", ...partial,
});

const snap = (elements: ObservedElement[]): Snapshot => ({
  url: "http://x/", title: "t", visibleText: "", elements,
});

// exact name beats fuzzy
{
  const a = el({ cuaId: "a", role: "button", name: "Search" });
  const b = el({ cuaId: "b", role: "button", name: "Search Again" });
  const res = resolveDescriptor({ role: "button", name: "Search" }, snap([b, a]));
  assert(!("error" in res) && res.element.cuaId === "a" && res.method === "semantic-exact");
}

// role mismatch never matches
assert.strictEqual(scoreElement({ role: "button", name: "Search" }, el({ role: "link", name: "Search" })), 0);

// data-dependent name: falls back to exact nearText anchor
{
  const raj = el({ cuaId: "raj", role: "link", name: "Raj Patel", nearText: "23456" });
  const res = resolveDescriptor({ role: "link", name: "Margaret Chen", nearText: "23456" }, snap([raj]));
  assert(!("error" in res) && res.element.cuaId === "raj");
}

// ...but only on EXACT nearText — no anchor, no match
{
  const raj = el({ cuaId: "raj", role: "link", name: "Raj Patel", nearText: "different" });
  const res = resolveDescriptor({ role: "link", name: "Margaret Chen", nearText: "23456" }, snap([raj]));
  assert("error" in res && res.error === "not_found");
}

// ambiguity without nth is an explicit error, not a silent first-match
{
  const a = el({ cuaId: "a", name: "Details", nearText: "row" });
  const b = el({ cuaId: "b", name: "Details", nearText: "row" });
  const res = resolveDescriptor({ role: "link", name: "Details", nearText: "row" }, snap([a, b]));
  assert("error" in res && res.error === "ambiguous");
}

// nth disambiguates ties
{
  const a = el({ cuaId: "a", name: "Details", nearText: "row" });
  const b = el({ cuaId: "b", name: "Details", nearText: "row" });
  const res = resolveDescriptor({ role: "link", name: "Details", nearText: "row", nth: 1 }, snap([a, b]));
  assert(!("error" in res) && res.element.cuaId === "b");
}

// structural fallback used only when semantics fail, and reported as such
{
  const a = el({ cuaId: "a", name: "Renamed Control", structuralPath: "html>body>table>tr>td>a" });
  const res = resolveDescriptor(
    { role: "link", name: "Old Name", structuralPath: "html>body>table>tr>td>a" },
    snap([a])
  );
  assert(!("error" in res) && res.method === "structural");
}

console.log("locator.test.ts: all assertions passed");

// short-fragment substring must NOT win a fuzzy match (unanchored-substring guard)
{
  const a = el({ cuaId: "a", role: "button", name: "OK" });
  const res = resolveDescriptor({ role: "button", name: "Blocked Operation Key" }, snap([a]));
  assert("error" in res && res.error === "not_found");
}

// substantial partials still match
assert(scoreElement({ role: "button", name: "Search" }, el({ role: "button", name: "Search Members" })) >= 2);
