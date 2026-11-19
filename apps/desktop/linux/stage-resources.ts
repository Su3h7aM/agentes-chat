// Copies the app's bundled resources into a folder, as Tauri's own bundler lays them out. The AppImage build calls it
// (build-appimage.sh) because it makes no Tauri bundle: the same `bundle.resources` of tauri.conf.json and of the
// native config are the one list, so a resource added there reaches the AppImage without a second edit.
//
// Usage: bun stage-resources.ts <src-tauri dir> <destination> <config file>...
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [tauriDir, destination, ...configs] = process.argv.slice(2);
if (!tauriDir || !destination || configs.length === 0) {
  console.error("usage: stage-resources.ts <src-tauri dir> <destination> <config file>...");
  process.exit(2);
}

type Resources = Record<string, string> | string[] | undefined;

function entriesOf(resources: Resources): [string, string][] {
  if (!resources) return [];
  // A list maps each path to the same path under the resource folder (Tauri's rule); the configs here use the map.
  if (Array.isArray(resources)) return resources.map((from) => [from, from]);
  return Object.entries(resources);
}

const wanted = new Map<string, string>();
for (const file of configs) {
  const config = JSON.parse(readFileSync(resolve(file), "utf8")) as { bundle?: { resources?: Resources } };
  for (const [from, to] of entriesOf(config.bundle?.resources)) wanted.set(from, to);
}

let copied = 0;
for (const [from, to] of wanted) {
  const matches = [...new Bun.Glob(basename(from)).scanSync({ cwd: resolve(tauriDir, dirname(from)), onlyFiles: false })];
  if (matches.length === 0) {
    console.error(`stage-resources: nothing matches ${from}`);
    process.exit(1);
  }
  for (const name of matches) {
    const source = resolve(tauriDir, dirname(from), name);
    // A destination ending in a slash is a folder the match goes into; otherwise it is the match's new path.
    const target = to.endsWith("/") ? join(destination, to, name) : join(destination, to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: statSync(source).isDirectory() });
    copied += 1;
  }
}
if (copied === 0 || !existsSync(destination)) {
  console.error("stage-resources: no resources were staged");
  process.exit(1);
}
console.log(`stage-resources: ${copied} entries into ${destination}`);
