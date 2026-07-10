/**
 * Minimal glob → predicate for `update --theirs/--keep-local` path selection.
 * Supports `**` (any path segment run), `*` (within a segment), `?` (one
 * char), and exact paths. No dependency; matching is against project-relative
 * POSIX paths.
 */
export function globToPredicate(globs: string[]): (p: string) => boolean {
  const regexps = globs.map((g) => {
    let re = "";
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === "*") {
        if (g[i + 1] === "*") {
          re += ".*";
          i++;
          // Collapse a following slash so `a/**/b` also matches `a/b`.
          if (g[i + 1] === "/") {
            re = re.slice(0, -2) + "(?:.*/)?";
            i++;
          }
        } else {
          re += "[^/]*";
        }
      } else if (ch === "?") {
        re += "[^/]";
      } else if (ch !== undefined && /[.+^${}()|[\]\\]/.test(ch)) {
        re += `\\${ch}`;
      } else {
        re += ch ?? "";
      }
    }
    return new RegExp(`^${re}$`);
  });
  return (p: string) => regexps.some((r) => r.test(p));
}
