/**
 * Shared gate for commands a pack wants the host tool to execute (MCP server
 * launch commands, hook commands). The primary control is declaration-based
 * (hook commands must appear in `permissions.shell.commands`, MCP servers in
 * `permissions.mcp.servers`); this gate is the defense-in-depth layer that
 * refuses shell/interpreter-escape shapes outright, since `bash -c …` makes
 * the declared "command" a container for an arbitrary script.
 *
 * Checked structurally (basename + flag inspection), not just by regex over
 * the joined string — the original regex missed combined flags like
 * `bash -lc` (codex re-review P1-2).
 */

const SHELL_BASENAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "ksh",
  "dash",
  "fish",
  "csh",
  "tcsh",
]);

/**
 * Command wrappers whose entire purpose is to launch *another* program (or open
 * an editor with a shell-out). None of these is ever a real MCP-server or hook
 * launch command, and each defeats the gate's core assumption — "the declared
 * command is what runs":
 *  - `env` rewrites the exec target and can plant `BASH_ENV` / `LD_PRELOAD` /
 *    `PATH` (so `env BASH_ENV=./payload.sh bash` runs a script with no `-c`).
 *  - `find -exec` / `xargs` / `watch` / `timeout` / `nohup` / `setsid` /
 *    `nice` / `stdbuf` / `flock` run an arbitrary trailing command.
 *  - `git -c core.pager='!cmd'` (and aliases) execute shell.
 *  - `make -f -`, `ssh host cmd`, `socat EXEC:…`, `nc -e`, `expect -c`,
 *    `gdb -ex`, and editors (`vim -c '!cmd'`) all reach a shell.
 * Rejected outright — they are indirection, not servers. (security-reviewer C1)
 */
const REJECTED_WRAPPER_BASENAMES = new Set([
  "env",
  "find",
  "xargs",
  "watch",
  "timeout",
  "nohup",
  "setsid",
  "nice",
  "stdbuf",
  "flock",
  "git",
  "make",
  "ssh",
  "socat",
  "nc",
  "ncat",
  "netcat",
  "expect",
  "gdb",
  "vim",
  "vi",
  "nvim",
  "view",
  "ed",
  "emacs",
]);

const INTERPRETER_EVAL_FLAGS: Record<string, RegExp> = {
  node: /^(-e|--eval|-p|--print)$/,
  deno: /^(eval)$/,
  bun: /^(-e|--eval)$/,
  python: /^-[A-Za-z]*c/, // python -c, -Ic, ...
  python3: /^-[A-Za-z]*c/,
  perl: /^-[A-Za-z]*[eE]/,
  ruby: /^-[A-Za-z]*e/,
  php: /^-[A-Za-z]*r/, // php -r '<code>'
  lua: /^-e$/,
  luajit: /^-e$/,
  rscript: /^-e$/, // Rscript -e '<code>' (basename lowercased)
  osascript: /^-e$/,
  // GNU sed executes shell via the `e` command (`…e cmd`) or the `s///e` flag.
  sed: /(^|[;\n])\s*e(\s|$)|s[^\w\s][^\n]*[^\w\s][a-z]*e[a-z]*$/,
};

// awk-family interpreters take the program as a positional arg, not behind a
// flag (`awk 'BEGIN{system("…")}'`), and `system()`/`"cmd"|getline` give
// arbitrary execution. An awk MCP server is not a real shape, so any awk
// invocation with a program arg is treated as a shell escape.
const AWK_BASENAMES = new Set(["awk", "gawk", "mawk", "nawk", "busybox"]);

function basename(command: string): string {
  const parts = command.split(/[\\/]+/);
  return (parts[parts.length - 1] ?? command).toLowerCase();
}

/**
 * True when `command` + `args` amount to "run an arbitrary inline script":
 *  - a shell invoked with any flag-cluster containing `c` (`-c`, `-lc`,
 *    `-xec`, ...), and
 *  - known interpreters invoked with their eval/print flags.
 * `eval` itself is rejected as a command.
 */
export function isShellEscape(command: string, args: readonly string[]): boolean {
  if (!command) return true;
  const base = basename(command);
  if (base === "eval") return true;
  // Indirection wrappers (env/find/xargs/git/make/…) run an arbitrary trailing
  // command and have no legitimate MCP-server/hook shape — reject outright.
  // NOTE: a *direct* interpreter running shipped code (`node server.js`,
  // `python -m pkg`) is NOT caught here and intentionally so — running bundled
  // code is what an MCP server IS. That risk is surfaced for install-time
  // consent by the risk engine, not blocked by this gate.
  if (REJECTED_WRAPPER_BASENAMES.has(base)) return true;
  if (SHELL_BASENAMES.has(base)) {
    return args.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  }
  if (AWK_BASENAMES.has(base)) {
    // busybox is only an awk shape when its applet is awk.
    if (base === "busybox" && args[0] !== "awk") {
      // fall through to interpreter/fallback checks below
    } else {
      return args.some((a) => !a.startsWith("-"));
    }
  }
  const evalFlag = INTERPRETER_EVAL_FLAGS[base];
  if (evalFlag) {
    return args.some((a) => evalFlag.test(a));
  }
  // Fallback string check for commands that embed the whole invocation in
  // one string (hook commands): catches `sh -c`, `bash -lc`, `node -e`, ...
  const joined = [command, ...args].join(" ");
  return /\b(?:sh|bash|zsh|ksh|dash|fish)\s+-[A-Za-z]*c\b|\bnode\s+(?:-e|--eval|-p)\b|\bpython3?\s+-[A-Za-z]*c\b|\bperl\s+-[A-Za-z]*[eE]\b|\bruby\s+-[A-Za-z]*e\b|\b(?:awk|gawk|mawk|nawk)\s+[^-]|\bphp\s+-[A-Za-z]*r\b|\b(?:lua|luajit|rscript|osascript)\s+-e\b|\beval\b/i.test(
    joined,
  );
}
