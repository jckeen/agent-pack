import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

/**
 * Write `content` to `target` atomically. Shared by apply (staged files +
 * lockfile) and uninstall (lockfile entry removal) — lives in its own module
 * because apply imports uninstall, so uninstall cannot import back from apply.
 */
export async function atomicWriteFile(
  target: string,
  content: string,
  flag: "w" | "wx" = "w",
): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  // Write the full content to a temp file and fsync it so a crash can never
  // expose a partially-written file at a user-visible path. The temp file's
  // distinctive `.tmp-<nonce>` name is never something recovery treats as a
  // staged install file, so an orphaned temp after a crash is inert.
  const fh = await fs.open(tmp, "wx");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    if (flag === "wx") {
      // Create-only: hardlink claims `target` atomically and fails with EEXIST
      // if a file was planted between plan and apply — preserving the O_EXCL
      // guarantee — while the temp file holds the fully-fsynced bytes, so the
      // create is never partial on disk. See security-reviewer finding #8.
      await fs.link(tmp, target);
      await fs.unlink(tmp);
    } else {
      // Replace existing content via atomic rename.
      await fs.rename(tmp, target);
    }
  } catch (err) {
    // On failure, clean up the temp file rather than leave it behind.
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
