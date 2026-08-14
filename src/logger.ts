import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// RunLogger — structured JSONL evidence for every run (discovery and replay).
// One directory per run: log.jsonl + screenshots. Everything written here has
// already passed redaction at the call site.
// ---------------------------------------------------------------------------
export class RunLogger {
  readonly dir: string;
  readonly runId: string;
  private stream: fs.WriteStream;
  private shotCount = 0;

  constructor(kind: "discovery" | "replay", baseDir = "evidence") {
    this.runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    this.dir = path.join(baseDir, this.runId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, "log.jsonl"), { flags: "a" });
  }

  event(type: string, data: Record<string, unknown> = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
    this.stream.write(line + "\n");
    // Console mirror, kept short.
    const brief = JSON.stringify(data).slice(0, 200);
    console.log(`  [${type}] ${brief}`);
  }

  screenshotPath(label: string): string {
    return path.join(this.dir, `${String(this.shotCount++).padStart(2, "0")}-${label}.png`);
  }

  writeFile(name: string, content: string) {
    fs.writeFileSync(path.join(this.dir, name), content);
  }

  close() {
    this.stream.end();
  }
}
