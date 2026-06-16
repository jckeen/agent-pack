import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import pc from "picocolors";

import {
  DEFAULT_REGISTRY_URL,
  ExitCode,
  loadManifest,
  resolveAtoms,
  signing,
  type AgentPackManifest,
} from "@agentpack/core";

import { getToken } from "../lib/credentials.js";
import { confirm } from "../lib/prompt.js";

interface PresignedUpload {
  path: string;
  url: string;
  headers: Record<string, string>;
}

interface InitResponse {
  publishId: string;
  expiresAt: string;
  presignedUploads: PresignedUpload[];
}

interface FinalizeResponse {
  packId: string;
  versionId: string;
  url: string;
}

interface PublishFile {
  path: string;
  sha256: string;
  bytes: number;
  atomId?: string;
  absPath: string;
}

export function registerPublish(program: Command): void {
  program
    .command("publish [path]")
    .description("Publish a pack to the AgentPack Registry.")
    .option("--registry <url>", "registry URL", DEFAULT_REGISTRY_URL)
    .option("-y, --yes", "skip confirmation", false)
    .option(
      "--sign",
      "sign the manifest with Sigstore keyless (default if OIDC token available)",
      true,
    )
    .option("--no-sign", "skip signing; pack will be unsigned in the registry")
    .action(
      async (
        pathArg: string | undefined,
        options: { registry: string; yes: boolean; sign: boolean },
      ) => {
        try {
          const registry = options.registry.replace(/\/+$/, "");
          const token = await getToken(registry);
          if (!token) {
            console.error(pc.red("Not logged in. Run `agentpack login` first."));
            process.exit(ExitCode.Generic);
          }
          const source = pathArg ?? process.cwd();
          const loaded = await loadManifest(source);
          const manifest = loaded.manifest;
          const manifestBytes = Buffer.from(loaded.rawYaml, "utf-8");
          const manifestSha256 = sha256OfBuffer(manifestBytes);

          const files = await collectFiles(loaded.packRoot, manifest);

          console.log(pc.bold(`\nPublish summary`));
          console.log(
            `  ${manifest.metadata.publisher}/${manifest.metadata.slug}@${manifest.metadata.version}`,
          );
          console.log(`  registry: ${registry}`);
          console.log(
            `  files: ${files.length + 1} (${humanBytes(manifestBytes.length + files.reduce((s, f) => s + f.bytes, 0))})`,
          );
          for (const f of files) {
            console.log(pc.dim(`    + ${f.path} (${humanBytes(f.bytes)})`));
          }

          if (!options.yes) {
            const ok = await confirm(pc.bold(`\nPublish? [y/N] `));
            if (!ok) {
              console.log(pc.dim("Aborted."));
              process.exit(1);
            }
          }

          // 1. POST /api/publish/init
          const initRes = await fetch(`${registry}/api/publish/init`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              publisher: manifest.metadata.publisher,
              pack: manifest.metadata.slug,
              version: manifest.metadata.version,
              manifestSha256,
              // manifestBytes was missing from the wire format pre-Phase-4
              // hardening; the registry synthesizes the manifest entry from
              // these two fields and DOES NOT expect AGENTPACK.yaml in `files`.
              manifestBytes: manifestBytes.length,
              files: files.map((f) => ({
                path: f.path,
                sha256: f.sha256,
                bytes: f.bytes,
                ...(f.atomId ? { atomId: f.atomId } : {}),
              })),
              metadata: {
                name: manifest.metadata.name,
                description: manifest.metadata.description,
                tags: manifest.metadata.tags ?? [],
                compatibilities: Object.entries(manifest.compatibility?.targets ?? {}).map(
                  ([target, value]) => ({
                    target,
                    status: value?.status ?? "experimental",
                  }),
                ),
              },
            }),
          });

          if (initRes.status === 401) {
            console.error(pc.red("Token rejected. Re-run `agentpack login`."));
            process.exit(ExitCode.Generic);
          }
          if (initRes.status === 403) {
            console.error(pc.red("Token lacks publish scope for this publisher."));
            process.exit(ExitCode.Generic);
          }
          if (initRes.status === 409) {
            console.error(
              pc.red(
                `Version ${manifest.metadata.version} already published. Bump the version and re-run.`,
              ),
            );
            process.exit(ExitCode.Conflict);
          }
          if (!initRes.ok) {
            const body = await initRes.text();
            console.error(pc.red(`publish init → HTTP ${initRes.status}: ${body}`));
            process.exit(ExitCode.Generic);
          }
          const init = (await initRes.json()) as InitResponse;

          // 2. PUT each presigned upload.
          const presignedByPath = new Map(init.presignedUploads.map((p) => [p.path, p]));
          // Upload manifest.
          await putBlob(
            presignedByPath.get("AGENTPACK.yaml"),
            manifestBytes,
            "AGENTPACK.yaml",
          );
          for (const f of files) {
            const presigned = presignedByPath.get(f.path);
            const bytes = await fs.readFile(f.absPath);
            await putBlob(presigned, bytes, f.path);
          }

          // 3a. (Optional) sign manifest via Sigstore keyless.
          let signedEnvelope: signing.SignedManifest | undefined;
          if (options.sign) {
            const hasToken =
              !!process.env["SIGSTORE_ID_TOKEN"] ||
              (!!process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] &&
                !!process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]);
            if (!hasToken) {
              console.error(
                pc.yellow(
                  "\n⚠ --sign was requested but no OIDC token is available. " +
                    "Set SIGSTORE_ID_TOKEN (e.g. `gh auth token`) or pass --no-sign.\n" +
                    "Aborting before finalize so you don't ship an unsigned version " +
                    "you meant to sign.",
                ),
              );
              process.exit(ExitCode.Generic);
            }
            try {
              // #35: sign the full release artifact (manifest digest + every
              // installable file digest), not just the manifest. The v2
              // envelope embeds the canonical release descriptor so verifiers
              // check downloaded bytes against the SIGNED digest set.
              console.log(
                pc.dim("  signing release artifact via Sigstore Fulcio + Rekor…"),
              );
              signedEnvelope = await signing.signReleaseDescriptor({
                manifestSha256,
                files: files.map((f) => ({
                  path: f.path,
                  sha256: f.sha256,
                  bytes: f.bytes,
                  ...(f.atomId ? { atomId: f.atomId } : {}),
                })),
              });
              console.log(
                pc.green(
                  `  ✓ signed by ${signedEnvelope.metadata.identity.san} (rekor #${signedEnvelope.metadata.rekorLogIndex}) — covers ${files.length + 1} files`,
                ),
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(pc.red(`signing failed: ${msg}`));
              process.exit(ExitCode.Generic);
            }
          }

          // 3b. POST /api/publish/<id>/finalize (with optional signature).
          const finalizeRes = await fetch(
            `${registry}/api/publish/${init.publishId}/finalize`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                publishId: init.publishId,
                ...(signedEnvelope ? { signature: signedEnvelope } : {}),
              }),
            },
          );
          if (finalizeRes.status === 410) {
            console.error(pc.red("Publish expired. Re-run `agentpack publish`."));
            process.exit(ExitCode.Generic);
          }
          if (finalizeRes.status === 422) {
            const body = (await finalizeRes.json()) as {
              error: string;
              mismatched?: Array<{
                path: string;
                expected: number;
                got: number | "missing";
              }>;
            };
            console.error(pc.red(`finalize: ${body.error}`));
            if (body.mismatched) {
              for (const m of body.mismatched) {
                console.error(pc.red(`  ! ${m.path}: expected ${m.expected} got ${m.got}`));
              }
            }
            process.exit(ExitCode.Generic);
          }
          if (!finalizeRes.ok) {
            console.error(
              pc.red(`finalize → HTTP ${finalizeRes.status} ${finalizeRes.statusText}`),
            );
            process.exit(ExitCode.Generic);
          }
          const final = (await finalizeRes.json()) as FinalizeResponse;
          console.log(
            pc.green(
              `\n✓ Published ${manifest.metadata.publisher}/${manifest.metadata.slug}@${manifest.metadata.version}`,
            ),
          );
          console.log(pc.dim(`  ${final.url}`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(pc.red(`publish failed: ${msg}`));
          process.exit(ExitCode.Generic);
        }
      },
    );
}

async function collectFiles(
  packRoot: string,
  manifest: AgentPackManifest,
): Promise<PublishFile[]> {
  const out: PublishFile[] = [];
  const allAtoms = resolveAtoms({ manifest, profile: "full" });
  for (const resolved of allAtoms) {
    const atom = resolved.atom;
    if (!atom.path) continue;
    const abs = path.resolve(packRoot, atom.path);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      const bytes = await fs.readFile(abs);
      out.push({
        path: path.relative(packRoot, abs).split(path.sep).join("/"),
        sha256: sha256OfBuffer(bytes),
        bytes: bytes.length,
        atomId: atom.id,
        absPath: abs,
      });
    } else if (stat.isDirectory()) {
      for await (const file of walkFiles(abs)) {
        const bytes = await fs.readFile(file);
        out.push({
          path: path.relative(packRoot, file).split(path.sep).join("/"),
          sha256: sha256OfBuffer(bytes),
          bytes: bytes.length,
          atomId: atom.id,
          absPath: file,
        });
      }
    }
  }
  return dedupe(out);
}

function dedupe(files: PublishFile[]): PublishFile[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}

async function putBlob(
  presigned: PresignedUpload | undefined,
  bytes: Buffer,
  filePath: string,
): Promise<void> {
  if (!presigned) {
    throw new Error(`missing presigned upload for ${filePath}`);
  }
  const res = await fetch(presigned.url, {
    method: "PUT",
    headers: presigned.headers,
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`PUT ${filePath} → HTTP ${res.status}`);
  }
}

function sha256OfBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
