// ---------------------------------------------------------------------------
// Parameter templating — the boundary between "one concrete run" and "a
// reusable capability". The recorder templatizes concrete values out of what
// it observed; the replay executor substitutes caller values back in.
//
// Both directions live here so the two halves of the round trip cannot drift
// apart, and so the boundary rules are testable without a browser.
// ---------------------------------------------------------------------------

export type ParamValues = Record<string, string>;

// A value only counts as a match when it is not embedded inside a larger
// alphanumeric token: "12" must template "?q=12" and "member 12" but never
// the middle of "Branch 120" or "abc12". Deliberately ASCII-alphanumeric —
// punctuation, currency symbols, and separators are all boundaries.
const isWordChar = (c: string) => c !== "" && /[A-Za-z0-9]/.test(c);

export function templatize(text: string, values: ParamValues): string {
  let out = text;
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    const token = `{{${name}}}`;
    let idx = out.indexOf(value);
    while (idx !== -1) {
      const before = idx > 0 ? out[idx - 1] : "";
      const after = out[idx + value.length] ?? "";
      if (!isWordChar(before) && !isWordChar(after)) {
        out = out.slice(0, idx) + token + out.slice(idx + value.length);
        idx = out.indexOf(value, idx + token.length);
      } else {
        idx = out.indexOf(value, idx + 1);
      }
    }
  }
  return out;
}

export function substitute(text: string, values: ParamValues): string {
  let out = text;
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    out = out.split(`{{${name}}}`).join(value);
  }
  return out;
}
