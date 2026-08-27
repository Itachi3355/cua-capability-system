import { chromium, type Browser, type Page } from "playwright";
import type { ElementDescriptor, ObservedElement, Snapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Surface — the seam between "how we perceive/act on a UI" and everything
// else (agent loop, recorder, replay). Discovery and replay both talk to this
// interface only. A desktop implementation (UIA/AX-tree, or screenshot+OCR)
// would implement the same contract: enumerate controls as role/name/nearText
// descriptors, act on a control by handle.
// ---------------------------------------------------------------------------
export interface Surface {
  navigate(url: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  click(cuaId: string): Promise<void>;
  type(cuaId: string, text: string): Promise<void>;
  select(cuaId: string, value: string): Promise<void>;
  readText(cuaId: string): Promise<string>;
  extractNear(anchor: string, cellIndex?: number): Promise<{ cells: string[]; value: string }>;
  url(): string;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

// Runs inside the page. Enumerates interactive controls the way an operator
// perceives them: what is it (role), what does it say (name), what label sits
// next to it (nearText). Stamps ephemeral data-cua-id handles for acting.
const ENUMERATE_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "hidden") return null;
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    return null;
  };
  const nameOf = (el, role) => {
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    if (role === "button" && el.tagName.toLowerCase() === "input") return clean(el.value);
    if (role === "textbox") return clean(el.placeholder || el.name || "");
    if (role === "select") return clean(el.name || "");
    return clean(el.textContent);
  };
  // Nearest label-ish text: previous <td>/<th>/<label> in the same row/parents.
  const nearOf = (el) => {
    let node = el;
    for (let depth = 0; depth < 4 && node; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const t = clean(sib.textContent);
        if (t) return t.slice(0, 80);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  };
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.tagName && parts.length < 12) {
      const tag = node.tagName.toLowerCase();
      const sibs = node.parentElement
        ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName)
        : [node];
      parts.unshift(sibs.length > 1 ? tag + ":" + sibs.indexOf(node) : tag);
      node = node.parentElement;
    }
    return parts.join(">");
  };
  const els = Array.from(document.querySelectorAll("a[href], button, input, select, textarea"));
  const out = [];
  let i = 0;
  for (const el of els) {
    const role = roleOf(el);
    if (!role) continue;
    if (el.offsetParent === null && el.type !== "hidden") continue; // not visible
    const cuaId = "cua-" + i++;
    el.setAttribute("data-cua-id", cuaId);
    const item = { cuaId, role, name: nameOf(el, role), nearText: nearOf(el), structuralPath: pathOf(el) };
    if (role === "select") {
      item.options = Array.from(el.options).map((o) => o.textContent.trim());
      item.value = el.options[el.selectedIndex]?.textContent.trim();
    } else if (role === "textbox") {
      item.value = el.value;
    }
    out.push(item);
  }
  return {
    url: location.href,
    title: document.title,
    visibleText: clean(document.body.innerText).slice(0, 4000),
    elements: out,
  };
})()`;

// Human-action capture listeners. Installed per-document; the sessionStorage
// flag (set for the duration of a handoff) makes them survive navigations —
// an operator's manual work often spans several page loads.
const HUMAN_CAPTURE_JS = `(() => {
  if (window.__cuaCaptureInstalled) return;
  if (sessionStorage.getItem("__cuaHumanCapture") !== "1") return;
  window.__cuaCaptureInstalled = true;
  const describe = (el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : "?";
    const label = ((el.getAttribute && el.getAttribute("aria-label")) || el.value || el.textContent || el.name || "")
      .replace(/\\s+/g, " ").trim().slice(0, 60);
    return tag + (el.type ? "[" + el.type + "]" : "") + ' "' + label + '"';
  };
  document.addEventListener("click", (e) => {
    if (e.target && window.__cuaHumanAction) window.__cuaHumanAction("click " + describe(e.target));
  }, true);
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !window.__cuaHumanAction) return;
    const value = t.type === "password" ? "«hidden»" : t.value;
    window.__cuaHumanAction("set " + describe(t) + ' = "' + value + '"');
  }, true);
})()`;

export class PlaywrightSurface implements Surface {
  private humanCb: ((desc: string) => void) | null = null;
  private constructor(private browser: Browser, public page: Page) {}

  static async launch(opts: { headful?: boolean; slowMoMs?: number } = {}): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: !opts.headful, slowMo: opts.slowMoMs ?? 0 });
    const page = await browser.newPage();
    const surface = new PlaywrightSurface(browser, page);
    // Page-level binding persists across navigations; routes to the active
    // capture callback (set only while a human holds control).
    await page.exposeFunction("__cuaHumanAction", (desc: string) => surface.humanCb?.(desc));
    await page.addInitScript(HUMAN_CAPTURE_JS);
    return surface;
  }

  async enableHumanCapture(cb: (desc: string) => void) {
    this.humanCb = cb;
    await this.page.evaluate(`sessionStorage.setItem("__cuaHumanCapture", "1")`);
    await this.page.evaluate(HUMAN_CAPTURE_JS); // current document too
  }

  async disableHumanCapture() {
    this.humanCb = null;
    await this.page.evaluate(`sessionStorage.removeItem("__cuaHumanCapture")`).catch(() => {});
  }

  async navigate(url: string) {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async snapshot(): Promise<Snapshot> {
    await this.page.waitForLoadState("domcontentloaded");
    return (await this.page.evaluate(ENUMERATE_JS)) as Snapshot;
  }

  private sel(cuaId: string) {
    return `[data-cua-id="${cuaId}"]`;
  }

  async click(cuaId: string) {
    await this.page.click(this.sel(cuaId), { timeout: 5000 });
  }

  async type(cuaId: string, text: string) {
    await this.page.fill(this.sel(cuaId), text, { timeout: 5000 });
  }

  async select(cuaId: string, value: string) {
    // Accept either option label or option value.
    const handle = this.page.locator(this.sel(cuaId));
    try {
      await handle.selectOption({ label: value }, { timeout: 3000 });
    } catch {
      await handle.selectOption(value, { timeout: 3000 });
    }
  }

  async readText(cuaId: string): Promise<string> {
    return (await this.page.textContent(this.sel(cuaId), { timeout: 5000 }))?.trim() ?? "";
  }

  // Anchor-based text extraction: find the deepest element whose text equals
  // (or starts with) the anchor label, then read the sibling cells after it —
  // the way a human reads across a labeled table row. Deterministic; no model.
  async extractNear(anchor: string, cellIndex?: number): Promise<{ cells: string[]; value: string }> {
    // String-form evaluate: bundlers (tsx/esbuild) inject helpers into
    // function-form callbacks that don't exist in the page context.
    const script = `((anchor) => {
      const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const all = Array.from(document.querySelectorAll("td, th, b, strong, span, div, li, dt"));
      const target =
        all.find((el) => clean(el.textContent) === anchor && el.children.length <= 1) ||
        all.find((el) => clean(el.textContent).startsWith(anchor) && el.children.length <= 1);
      if (!target) return null;
      let node = target;
      for (let depth = 0; depth < 3 && node; depth++) {
        const cells = [];
        let sib = node.nextElementSibling;
        while (sib && cells.length < 6) {
          const t = clean(sib.textContent);
          if (t) cells.push(t);
          sib = sib.nextElementSibling;
        }
        if (cells.length) return cells;
        node = node.parentElement;
      }
      return [];
    })(${JSON.stringify(anchor)})`;
    const result = (await this.page.evaluate(script)) as string[] | null;
    if (result === null) throw new Error(`extract anchor not found: "${anchor}"`);
    const value = cellIndex !== undefined ? result[cellIndex] ?? "" : result.join(" | ");
    return { cells: result, value };
  }

  url() {
    return this.page.url();
  }

  async screenshot(path: string) {
    await this.page.screenshot({ path, fullPage: true });
  }

  async close() {
    await this.browser.close();
  }
}

// ---------------------------------------------------------------------------
// Locator resolution — replay-side matching of a recorded descriptor against
// a live snapshot. Semantic first, structural last.
// ---------------------------------------------------------------------------
export interface Resolution {
  element: ObservedElement;
  method: "semantic-exact" | "semantic-fuzzy" | "structural";
  score: number;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Structural-path policy.
//
// A structural path (tag chain with indices) is a DOM fingerprint: it is the
// least portable thing we can record, and on a legacy surface it is also the
// most likely to be wrong after a cosmetic template change. We keep it only
// where perceptual identity is genuinely weak:
//
//   - ties at record time (nth was needed)  -> disambiguation insurance
//   - stable name shorter than 3 chars      -> "q", "nick", pure {{param}}
//
// Everything else ("Open Sub-Account", "Confirm and Open Account") is
// identified well enough by role + name + nearText alone.
// ---------------------------------------------------------------------------
export function needsStructuralFallback(
  name: string,
  _nearText: string | undefined,
  hadTies: boolean
): boolean {
  if (hadTies) return true;
  // Judge only the stable portion: a name that is mostly a parameter template
  // carries little perceptual weight of its own.
  const stable = name.replace(/\{\{[^}]+\}\}/g, "").trim();
  return stable.length < 3;
}

// Strip structural paths that the policy above says are unnecessary. Applied
// at record time, and available as an explicit `clean-artifacts` CLI pass for
// artifacts recorded before the policy existed. Deliberately NOT applied on
// load during replay: the artifact is the contract, and silently rewriting a
// saved capability's locators at execution time would undermine that.
export function cleanStructuralPaths<T extends { steps: unknown[]; recoveries?: unknown[] }>(artifact: T): T {
  const cleanDesc = (d: ElementDescriptor | undefined) => {
    if (!d?.structuralPath) return d;
    if (needsStructuralFallback(d.name ?? "", d.nearText, d.nth !== undefined)) return d;
    const { structuralPath, ...rest } = d;
    return rest;
  };

  for (const step of artifact.steps as { target?: ElementDescriptor; expect?: { targetVisible?: ElementDescriptor } }[]) {
    if (step.target) step.target = cleanDesc(step.target)!;
    if (step.expect?.targetVisible) step.expect.targetVisible = cleanDesc(step.expect.targetVisible)!;
  }
  for (const rule of (artifact.recoveries ?? []) as { do?: { click?: ElementDescriptor } }[]) {
    if (rule.do?.click) rule.do.click = cleanDesc(rule.do.click)!;
  }
  return artifact;
}

export function scoreElement(desc: ElementDescriptor, el: ObservedElement): number {
  if (desc.role !== "other" && el.role !== desc.role) return 0;
  let score = 0;
  const dn = norm(desc.name);
  const en = norm(el.name);
  // Partial credit requires the contained string to be substantial (>= 4
  // chars) — a 1-2 char fragment must not win a fuzzy match uncontested.
  const partial =
    (dn.length >= 4 && en.includes(dn)) || (en.length >= 4 && dn.includes(en));
  const nameMatched = dn.length > 0 && (en === dn || partial);
  if (dn && en === dn) score += 3;
  else if (nameMatched) score += 2;
  if (desc.nearText) {
    const dnear = norm(desc.nearText);
    const enear = norm(el.nearText);
    if (dnear && enear === dnear) score += 2;
    else if ((dnear.length >= 4 && enear.includes(dnear)) || (enear.length >= 4 && dnear.includes(enear))) score += 1;
  }
  // Data-dependent names: a results-row link's text changes with the data
  // ("Margaret Chen" vs "Raj Patel"), but its anchor cell (the parameterized
  // member #) is recorded as nearText. If the name failed, allow a match only
  // on an EXACT nearText anchor — strict, to avoid false positives.
  if (dn && !nameMatched) {
    if (desc.nearText && norm(desc.nearText) === norm(el.nearText)) return 2;
    return 0;
  }
  return score;
}

export function resolveDescriptor(
  desc: ElementDescriptor,
  snapshot: Snapshot
): Resolution | { error: "not_found" | "ambiguous"; detail: string } {
  const scored = snapshot.elements
    .map((el) => ({ el, score: scoreElement(desc, el) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const best = scored[0].score;
    const ties = scored.filter((s) => s.score === best);
    if (ties.length === 1) {
      return {
        element: ties[0].el,
        method: best >= 3 ? "semantic-exact" : "semantic-fuzzy",
        score: best,
      };
    }
    if (desc.nth !== undefined && desc.nth < ties.length) {
      return { element: ties[desc.nth].el, method: "semantic-fuzzy", score: best };
    }
    return {
      error: "ambiguous",
      detail: `${ties.length} elements tie for "${desc.name}" (role=${desc.role}); no nth recorded`,
    };
  }

  // Structural fallback — least trusted, flagged in results.
  if (desc.structuralPath) {
    const hit = snapshot.elements.find((el) => el.structuralPath === desc.structuralPath);
    if (hit) return { element: hit, method: "structural", score: 0 };
  }

  return {
    error: "not_found",
    detail: `no element matched role=${desc.role} name="${desc.name}" near="${desc.nearText ?? ""}"`,
  };
}
