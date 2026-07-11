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
 *  - Git config overrides such as `git -c core.pager='!cmd'` execute shell;
 *    ordinary fixed subcommands such as `git status` remain usable as hooks.
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
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse"]);

function basename(command: string): string {
  const parts = command.split(/[\\/]+/);
  return (parts[parts.length - 1] ?? command).toLowerCase().replace(/\.exe$/, "");
}

function tokenizeCommand(command: string): string[] {
  return (
    command
      .trim()
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((token) => token.replace(/^["']|["']$/g, "")) ?? []
  );
}

function containsShellComposition(command: string): boolean {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && !singleQuoted) {
      index += 1;
      continue;
    }
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (
      char === "^" ||
      (!singleQuoted && (char === "`" || char === "\r" || char === "\n"))
    ) {
      return true;
    }
    if (!singleQuoted && char === "$" && command[index + 1] === "(") return true;
    if (!singleQuoted && !doubleQuoted && ";&|<>".includes(char)) return true;
  }
  return false;
}

function normalizePowerShellFlag(arg: string): string {
  return arg.toLowerCase().replace(/^[\u2013\u2014\u2015]/, "-");
}

function isPowerShellEvalFlag(arg: string): boolean {
  const flag = normalizePowerShellFlag(arg);
  return (
    flag.length > 1 && ("-command".startsWith(flag) || "-encodedcommand".startsWith(flag))
  );
}

function isPowerShellFileFlag(arg: string): boolean {
  const flag = normalizePowerShellFlag(arg);
  return flag.length > 1 && "-file".startsWith(flag);
}

function containsWindowsShellEval(command: string, args: readonly string[]): boolean {
  const commandTokens = tokenizeCommand(command);
  const executable = basename(commandTokens[0] ?? "");
  const trailing = [...commandTokens.slice(1), ...args];
  if (
    /%[^%]+%/.test(executable) ||
    ["$env:comspec", "${env:comspec}"].includes(executable)
  ) {
    return true;
  }
  if (executable === "powershell" || executable === "pwsh") {
    if (trailing.some(isPowerShellEvalFlag)) return true;
    if (!trailing.some(isPowerShellFileFlag)) return true;
  }
  return executable === "cmd";
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
  if (containsShellComposition(command)) return true;
  const firstRawWord = command.match(/^\S+/)?.[0] ?? command;
  if (!/^["']/.test(command) && /["']/.test(firstRawWord)) return true;
  const commandTokens = tokenizeCommand(command);
  const firstToken = commandTokens[0] ?? command;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) return true;
  if (/^\$\{?(?:SHELL|COMSPEC)\}?$/i.test(firstToken)) return true;
  if (containsWindowsShellEval(command, args)) return true;
  const base = basename(commandTokens[0] ?? command);
  const effectiveArgs = [...commandTokens.slice(1), ...args];
  if (base === "eval") return true;
  // Indirection wrappers (env/find/xargs/git/make/…) run an arbitrary trailing
  // command and have no legitimate MCP-server/hook shape — reject outright.
  // NOTE: a *direct* interpreter running shipped code (`node server.js`,
  // `python -m pkg`) is NOT caught here and intentionally so — running bundled
  // code is what an MCP server IS. That risk is surfaced for install-time
  // consent by the risk engine, not blocked by this gate.
  if (REJECTED_WRAPPER_BASENAMES.has(base)) return true;
  if (base === "git") {
    const subcommand = effectiveArgs[0] ?? "";
    return (
      !SAFE_GIT_SUBCOMMANDS.has(subcommand) ||
      effectiveArgs.some(
        (arg) =>
          arg.startsWith("--config-env") ||
          arg === "--ext-diff" ||
          arg === "--textconv" ||
          /(?:pager|alias)\s*=/.test(arg),
      )
    );
  }
  if (SHELL_BASENAMES.has(base)) {
    return effectiveArgs.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  }
  if (AWK_BASENAMES.has(base)) {
    // busybox is only an awk shape when its applet is awk.
    if (base === "busybox" && effectiveArgs[0] !== "awk") {
      // fall through to interpreter/fallback checks below
    } else {
      return effectiveArgs.some((a) => !a.startsWith("-"));
    }
  }
  const evalFlag = INTERPRETER_EVAL_FLAGS[base];
  if (evalFlag) {
    return effectiveArgs.some((a) => evalFlag.test(a));
  }
  // Fallback string check for commands that embed the whole invocation in
  // one string (hook commands): catches `sh -c`, `bash -lc`, `node -e`, ...
  const joined = [command, ...args].join(" ");
  return /\b(?:sh|bash|zsh|ksh|dash|fish)\s+-[A-Za-z]*c\b|\bnode\s+(?:-e|--eval|-p)\b|\bpython3?\s+-[A-Za-z]*c\b|\bperl\s+-[A-Za-z]*[eE]\b|\bruby\s+-[A-Za-z]*e\b|\b(?:awk|gawk|mawk|nawk)\s+[^-]|\bphp\s+-[A-Za-z]*r\b|\b(?:lua|luajit|rscript|osascript)\s+-e\b|\b(?:powershell|pwsh)(?:\.exe)?\s+-(?:c(?:ommand)?|e(?:n(?:c(?:odedcommand)?)?)?)\b|\bcmd(?:\.exe)?\s+\/[ck]\b|\beval\b/i.test(
    joined,
  );
}

export function isCredentialFreeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const segments = decodedPath.split("/").filter(Boolean);
    const hasCredentialSegment = segments.some(
      (segment, index) =>
        /^(?:sk|pk|gh[pousr]|github_pat|xox[baprs]|pat)[-_][A-Za-z0-9_-]{6,}$/i.test(
          segment,
        ) ||
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(segment) ||
        (/^(?:s|session|token|access[-_]?token|secret|credential|password|api[-_]?key|key|auth)$/i.test(
          segment,
        ) &&
          segments[index + 1] !== undefined &&
          !/^(?:mcp|sse|events)$/i.test(segments[index + 1] ?? "")),
    );
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      !decodedPath.includes(";") &&
      !hasCredentialSegment
    );
  } catch {
    return false;
  }
}
