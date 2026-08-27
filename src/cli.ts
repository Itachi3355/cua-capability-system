import fs from "node:fs";
import path from "node:path";
import { Artifact as ArtifactSchema } from "./types.js";
import { loadPolicy } from "./policy.js";
import { cleanStructuralPaths } from "./surface.js";
import { runDiscovery } from "./agent.js";
import { replayArtifact } from "./replay.js";

// ---------------------------------------------------------------------------
// CLI
//   discover --goal "..." --url http://... [--app label] [--param k=v]...
//            [--desc k="..."]... [--sensitive k]... [--headless] [--max-steps N]
//   replay   --artifact artifacts/x.json [--param k=v]... [--allow-risky]
//            [--headless] [--no-escalate]
//   approve  --artifact artifacts/x.json
//   list
// ---------------------------------------------------------------------------

const ARTIFACT_DIR = "artifacts";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = { param: [], desc: [], sensitive: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key in multi) {
      multi[key].push(next);
      i++;
    } else if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, multi };
}

function parseParams(multi: Record<string, string[]>) {
  const descs = new Map(
    multi.desc.map((d) => {
      const eq = d.indexOf("=");
      return [d.slice(0, eq), d.slice(eq + 1)] as const;
    })
  );
  return multi.param.map((p) => {
    const eq = p.indexOf("=");
    const name = p.slice(0, eq);
    return {
      name,
      value: p.slice(eq + 1),
      description: descs.get(name) ?? name.replace(/_/g, " "),
      sensitive: multi.sensitive.includes(name),
    };
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, multi } = parseArgs(rest);
  const policy = loadPolicy((flags.policy as string) || "policy.json");

  if (cmd === "discover") {
    if (!flags.goal || !flags.url) {
      console.error('Usage: npm run discover -- --goal "..." --url http://... [--param k=v] [--desc k="..."] [--sensitive k]');
      process.exit(2);
    }
    const params = parseParams(multi);
    const { artifact, evidenceDir } = await runDiscovery({
      goal: flags.goal as string,
      entryUrl: flags.url as string,
      appLabel: (flags.app as string) || new URL(flags.url as string).host,
      params,
      policy,
      maxSteps: Number(flags["max-steps"] ?? 25),
      model: (flags.model as string) || process.env.CUA_MODEL || "claude-sonnet-5",
      headful: !flags.headless,
    });
    if (!artifact) {
      console.error(`\nDiscovery did not produce an artifact. Evidence: ${evidenceDir}`);
      process.exit(1);
    }
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const file = path.join(ARTIFACT_DIR, `${artifact.name}.v${artifact.version}.json`);
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
    console.log(`\nCapability recorded: ${file} (approval: ${artifact.approval})`);
    console.log(`Evidence: ${evidenceDir}`);
    return;
  }

  if (cmd === "replay") {
    const file = flags.artifact as string;
    if (!file) {
      console.error("Usage: npm run replay -- --artifact artifacts/x.json [--param k=v] [--allow-risky]");
      process.exit(2);
    }
    const artifact = ArtifactSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const params = Object.fromEntries(parseParams(multi).map((p) => [p.name, p.value]));
    const result = await replayArtifact(artifact, {
      params,
      policy,
      headful: !flags.headless,
      allowRisky: Boolean(flags["allow-risky"]),
      escalate: !flags["no-escalate"],
      slowMoMs: flags.slow === true ? 800 : flags.slow ? Number(flags.slow) : 0,
    });
    console.log("\n=== REPLAY RESULT ===");
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "failure" ? 1 : 0);
  }

  if (cmd === "approve") {
    const file = flags.artifact as string;
    const artifact = ArtifactSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    artifact.approval = "approved";
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
    console.log(`${artifact.name} v${artifact.version} approved for unattended/risky replay.`);
    return;
  }

  if (cmd === "clean-artifacts") {
    // Explicit, opt-in rewrite: strips structural fallbacks that the locator
    // policy deems unnecessary (see needsStructuralFallback). Applied here and
    // at record time — never silently on load, because the saved artifact is
    // the contract a caller replays.
    for (const f of fs.readdirSync(ARTIFACT_DIR).filter((f) => f.endsWith(".json"))) {
      const file = path.join(ARTIFACT_DIR, f);
      const before = fs.readFileSync(file, "utf8");
      const a = cleanStructuralPaths(ArtifactSchema.parse(JSON.parse(before)));
      const after = JSON.stringify(a, null, 2);
      const dropped = (before.match(/structuralPath/g) ?? []).length - (after.match(/structuralPath/g) ?? []).length;
      fs.writeFileSync(file, after);
      console.log(`${f}: dropped ${dropped} structural path(s)`);
    }
    return;
  }

  if (cmd === "list") {
    if (!fs.existsSync(ARTIFACT_DIR)) return console.log("(no artifacts)");
    for (const f of fs.readdirSync(ARTIFACT_DIR).filter((f) => f.endsWith(".json"))) {
      const a = ArtifactSchema.parse(JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, f), "utf8")));
      console.log(`${a.name} v${a.version} [${a.approval}] — ${a.description}`);
      console.log(`  params: ${a.params.map((p) => p.name + (p.sensitive ? " (sensitive)" : "")).join(", ") || "none"}`);
      console.log(`  outputs: ${a.outputs.map((o) => o.name).join(", ") || "none"} | steps: ${a.steps.length} | file: ${f}`);
    }
    return;
  }

  console.error("Unknown command. Use: discover | replay | approve | list | clean-artifacts");
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
