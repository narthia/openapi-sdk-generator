/**
 * Output-directory cleaning strategies.
 *
 * `"generated"` mode prunes only the files this generator recognizes as its own
 * (they start with {@link GENERATED_HEADER}), so hand-written files in the output
 * directory survive without having to be listed anywhere.
 *
 * That recognition is why `header: false` cannot be combined with this mode:
 * without the header nothing is identifiable as generated, so pruning would
 * silently do nothing. `generateSdk` rejects the combination up front.
 */
import { open, readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { GENERATED_HEADER } from "./emit/emit-types.ts";

/**
 * How the output directory is cleaned before writing:
 * - `true` (default): remove the whole directory.
 * - `false`: remove nothing; regenerated files are still overwritten.
 * - `"generated"`: remove only previously generated files that this run no
 *   longer emits, leaving hand-written files in place.
 */
export type CleanMode = boolean | "generated";

/** `rm` retries ride out the transient EBUSY/EPERM that Windows reports on locked files. */
const RM_OPTIONS = { force: true, maxRetries: 3, retryDelay: 100 } as const;

/** Bytes needed to recognize the header; reading more would be wasted on large type files. */
const HEADER_BYTES = Buffer.byteLength(GENERATED_HEADER);

/** Remove the output directory wholesale. */
export async function removeOutput(output: string): Promise<void> {
  await rm(output, { recursive: true, ...RM_OPTIONS });
}

/**
 * Remove generated files that are no longer emitted, then drop the directories
 * left empty behind them. Files without the generated header are never touched,
 * and neither are the paths in `keep` (the set this run is about to write,
 * expressed with `/` separators, as in {@link GeneratedFile.path}).
 */
export async function pruneGenerated(output: string, keep: Set<string>): Promise<void> {
  await pruneDir(output, output, keep);
}

/** Prune one directory; resolves to `true` when nothing is left in it afterwards. */
async function pruneDir(dir: string, root: string, keep: Set<string>): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false; // no output directory yet (or unreadable): nothing to prune
  }

  let kept = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      const emptied = await pruneDir(path, root, keep);
      if (emptied) await rm(path, { recursive: true, ...RM_OPTIONS });
      else kept++;
      continue;
    }

    // Anything that is not a plain file (symlink, socket, ...) is left alone.
    if (!entry.isFile() || keep.has(toPosix(relative(root, path))) || !(await isGenerated(path))) {
      kept++;
      continue;
    }
    await rm(path, RM_OPTIONS);
  }

  return kept === 0;
}

/** True when the file starts with the generated header, i.e. this generator owns it. */
async function isGenerated(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8") === GENERATED_HEADER;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Generated file paths always use `/`; `relative` yields `\` on Windows. */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
