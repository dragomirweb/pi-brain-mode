/**
 * bash-classifier.ts — PURE. No Pi/host imports, no I/O, no async.
 *
 * HEURISTIC ONLY: shell is Turing-complete and can trivially obfuscate intent.
 * This classifier is a best-effort convenience/secondary gate for default Brain
 * Mode bash calls, not a security boundary. It gates common write/exec channels
 * in otherwise allowlisted commands, including `env` prefixes, newline/`&`
 * chaining, awk system/pipe/getline, sed w/e/r commands, find -exec/-fprint*,
 * sort -o, wget/curl output flags, and `&>` file redirects. Residual gaps
 * remain (for example, exotic sed `s///e` with addressing, novel tool flags,
 * variable indirection, unicode/whitespace tricks, and other shell evasions).
 *
 * For hard enforcement, use `--brain-no-bash` to remove bash entirely. The
 * edit/write tools are always hard-removed in Brain Mode; this module is only
 * the live read-only bash convenience gate.
 */

export type BashVerdict = "allow" | "block";

export interface BashClassification {
  verdict: BashVerdict;
  /** machine-readable reason code */
  code:
    | "allowed_safe"
    | "blocked_destructive"
    | "blocked_unrecognized"
    | "blocked_unparseable"
    | "blocked_chained_unsafe";
  /** human/LLM-facing explanation (used as the tool_call block reason upstream) */
  reason: string;
  /** the specific command segment that triggered the verdict, when applicable */
  offendingSegment?: string;
}

type BlockCode = Exclude<BashClassification["code"], "allowed_safe" | "blocked_chained_unsafe">;

type SegmentClassification =
  | { verdict: "allow"; code: "allowed_safe"; reason: string }
  | { verdict: "block"; code: BlockCode; reason: string; offendingSegment: string };

const DESTRUCTIVE: RegExp[] = [
  /^(rm|rmdir|unlink|shred|mv|cp|truncate|ln)\b/,
  /^sed\b.*(?:^|\s)-i(?:\b|[^\w])/,
  /^perl\b.*(?:^|\s)-i(?:\b|[^\w])/,
  /^awk\b.*>/,
  /^(ed|vim|nvim|nano|emacs|vi|code|subl)\b/,
  /^tee\b/,
  /^dd\b/,
  /^npm\s+(install|i|ci|uninstall|publish)\b/,
  /^pnpm\s+add\b/,
  /^yarn\s+add\b/,
  /^bun\s+add\b/,
  /^pip\s+install\b/,
  /^cargo\s+install\b/,
  /^apt(-get)?\s+install\b/,
  /^brew\s+install\b/,
  /^go\s+install\b/,
  /^git\s+(commit|push|checkout|switch|clean|rebase|merge|stash|rm|mv|apply)\b/,
  /^git\s+reset\b.*(?:^|\s)--hard(?:\s|$)/,
  /^git\s+tag\b.*(?:^|\s)-d(?:\s|$)/,
  /^git\s+branch\b.*(?:^|\s)-d(?:\s|$)/,
  /^(chmod|chown|chgrp|mount|umount|kill|pkill|systemctl|service|shutdown|reboot|mkfs)\b/,
  /^(bash|sh)\s+-c\b/,
  /^(mkdir|touch)\b/,
  /^find\b.*(?:^|\s)-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)(?:\s|$)/,
];

const OPAQUE: RegExp[] = [
  /\$\(/,
  /`/,
  /<\(/,
  />\(/,
  /(?:^|\s)(eval|exec)\b/,
  /^(source|\.)\s+\S+/,
  /\bbase64\s+(-d|--decode)\b/,
  /\bxxd\s+-r\b/,
  /\b(python3?|perl|node)\s+(-c|-e)\b/,
];

const SAFE_SIMPLE_HEADS = new Set([
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "nl",
  "od",
  "hexdump",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "grep",
  "egrep",
  "rg",
  "ripgrep",
  "ag",
  "find",
  "which",
  "whereis",
  "locate",
  "type",
  "ls",
  "pwd",
  "dirname",
  "basename",
  "realpath",
  "readlink",
  "echo",
  "printf",
  "jq",
  "yq",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "tr",
  "column",
  "comm",
  "diff",
  "cmp",
  "date",
  "printenv",
  "uname",
  "whoami",
  "id",
  "ps",
]);

const XARGS_OPTIONS_WITH_VALUE = new Set([
  "-0",
  "--null",
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "--eof",
  "-I",
  "--replace",
  "-L",
  "--max-lines",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "-s",
  "--max-chars",
]);

/** Classify a single bash command string. Pure + synchronous. */
export function classifyBashCommand(command: string): BashClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return block("blocked_unparseable", "bash blocked: empty command; failing closed.");
  }

  let segments: string[];
  try {
    segments = splitTopLevel(trimmed);
  } catch {
    return block("blocked_unparseable", "bash blocked: could not parse command; failing closed.");
  }

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const classification = classifySegment(segment);
    if (classification.verdict === "block") {
      if (index > 0) {
        return {
          verdict: "block",
          code: "blocked_chained_unsafe",
          reason: `bash blocked: chained segment '${classification.offendingSegment}' is not read-only (${classification.reason})`,
          offendingSegment: classification.offendingSegment,
        };
      }
      return classification;
    }
  }

  return { verdict: "allow", code: "allowed_safe", reason: "bash allowed: read-only command." };
}

function classifySegment(segment: string): SegmentClassification {
  const stripped = stripPrefixes(segment).trim();
  if (!stripped) {
    return segmentBlock(
      "blocked_unparseable",
      "bash blocked: empty command segment; failing closed.",
      segment,
    );
  }

  if (OPAQUE.some((pattern) => pattern.test(stripped))) {
    return segmentBlock(
      "blocked_unrecognized",
      "bash blocked: command uses an opaque shell construct.",
      stripped,
    );
  }

  if (hasFileRedirect(stripped)) {
    return segmentBlock(
      "blocked_destructive",
      "bash blocked: command writes a file via redirection.",
      stripped,
    );
  }

  if (DESTRUCTIVE.some((pattern) => pattern.test(stripped))) {
    return segmentBlock(
      "blocked_destructive",
      "bash blocked: command matches the destructive denylist.",
      stripped,
    );
  }

  if (!isAllowlisted(stripped)) {
    return segmentBlock(
      "blocked_unrecognized",
      "bash blocked: command is not on the read-only allowlist.",
      stripped,
    );
  }

  return { verdict: "allow", code: "allowed_safe", reason: "read-only command segment" };
}

function isAllowlisted(segment: string): boolean {
  let tokens: string[];
  try {
    tokens = tokenizeWords(segment);
  } catch {
    return false;
  }

  if (tokens.length === 0) {
    return false;
  }

  const [head] = tokens;
  if (SAFE_SIMPLE_HEADS.has(head)) {
    if (head === "find") {
      return !tokens.some((token) =>
        ["-delete", "-exec", "-execdir", "-fprint", "-fprintf", "-fls", "-ok", "-okdir"].includes(
          token,
        ),
      );
    }
    if (head === "sed") {
      return (
        !tokens.some(
          (token) => token === "-i" || token.startsWith("-i") || token.startsWith("--in-place"),
        ) &&
        !/[;{\s'"\/]\d*[wWrR]\s+\S/.test(segment) &&
        !/[;{\s'"\/]\d*e\s+\S/.test(segment)
      );
    }
    if (head === "awk") {
      return (
        !segment.includes(">") &&
        !segment.includes("|") &&
        !/\bsystem\b/.test(segment) &&
        !/\bgetline\b/.test(segment)
      );
    }
    if (head === "sort") {
      return !tokens.some(
        (token) =>
          token === "-o" ||
          token === "--output" ||
          token.startsWith("--output=") ||
          (token.startsWith("-o") && token.length > 2),
      );
    }
    return true;
  }

  if (head === "top") {
    return tokens.includes("-b") && tokens.includes("-n1");
  }

  if (head === "git") {
    return isSafeGit(tokens);
  }

  if (head === "npm") {
    return ["ls", "list", "view", "outdated"].includes(tokens[1] ?? "");
  }

  if (head === "pnpm") {
    return tokens[1] === "list";
  }

  if (head === "yarn") {
    return tokens[1] === "list";
  }

  if (head === "pip") {
    return tokens[1] === "show" || tokens[1] === "list";
  }

  if (head === "cargo") {
    return tokens[1] === "tree";
  }

  if (head === "curl") {
    return !hasCurlWriteFlag(tokens);
  }

  if (head === "wget") {
    return hasWgetStdoutTarget(tokens);
  }

  if (head === "xargs") {
    return isSafeXargs(tokens);
  }

  return false;
}

function isSafeGit(tokens: string[]): boolean {
  const subcommand = tokens[1] ?? "";
  if (
    ["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "describe"].includes(
      subcommand,
    )
  ) {
    return true;
  }

  if (subcommand === "branch") {
    return !tokens.some((token) => token === "-d" || token === "-D" || token === "--delete");
  }

  if (subcommand === "remote") {
    return tokens.length === 3 && tokens[2] === "-v";
  }

  return false;
}

function hasCurlWriteFlag(tokens: string[]): boolean {
  return tokens.some(
    (token, index) =>
      token === "-O" ||
      token === "--remote-name" ||
      token === "-o" ||
      token === "--output" ||
      token.startsWith("--output=") ||
      (token.startsWith("-o") && token.length > 2) ||
      /^-[A-Za-z]*O$/.test(token) ||
      (/^-[A-Za-z]+o$/.test(token) && token.length > 2 && tokens[index + 1] !== "-") ||
      ((tokens[index - 1] === "-o" || tokens[index - 1] === "--output") && token !== "-"),
  );
}

function hasWgetStdoutTarget(tokens: string[]): boolean {
  let hasStdoutTarget = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "-O" || token === "--output-document") {
      if (tokens[index + 1] !== "-") {
        return false;
      }
      hasStdoutTarget = true;
      index++;
      continue;
    }
    if (token === "-O-" || token === "--output-document=-" || /^-[A-Za-z]*O-$/.test(token)) {
      hasStdoutTarget = true;
      continue;
    }
    if (token.startsWith("--output-document=") || /^-[A-Za-z]*O.+/.test(token)) {
      return false;
    }
  }
  return hasStdoutTarget;
}

function isSafeXargs(tokens: string[]): boolean {
  const innerStart = findXargsInnerStart(tokens);
  if (innerStart < 0) {
    return false;
  }

  const innerCommand = tokens.slice(innerStart).join(" ");
  return classifySegment(innerCommand).verdict === "allow";
}

function findXargsInnerStart(tokens: string[]): number {
  let skipNext = false;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "<") {
      skipNext = true;
      continue;
    }
    if (token.startsWith("<")) {
      continue;
    }
    if (XARGS_OPTIONS_WITH_VALUE.has(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return index;
  }
  return -1;
}

function splitTopLevel(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushSegment = () => {
    const trimmed = current.trim();
    if (!trimmed) {
      throw new Error("empty segment");
    }
    segments.push(trimmed);
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      current += char;
      continue;
    }

    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      current += char;
      continue;
    }

    if (!quote) {
      if (char === ";" || char === "\n" || char === "\r") {
        pushSegment();
        continue;
      }
      if (char === "&" && next === "&") {
        pushSegment();
        index++;
        continue;
      }
      if (char === "&" && next !== ">" && command[index - 1] !== ">") {
        pushSegment();
        continue;
      }
      if (char === "|" && next === "|") {
        pushSegment();
        index++;
        continue;
      }
      if (char === "|") {
        pushSegment();
        continue;
      }
    }

    current += char;
  }

  if (escaped || quote) {
    throw new Error("unterminated quote or escape");
  }

  pushSegment();
  return segments;
}

function stripPrefixes(segment: string): string {
  let tokens: string[];
  try {
    tokens = tokenizeWords(segment);
  } catch {
    return segment.trim();
  }

  let index = 0;
  while (tokens[index] === "sudo") {
    index++;
  }

  if (tokens[index] === "env") {
    index++;
    while (index < tokens.length && isAssignment(tokens[index])) {
      index++;
    }
  }

  while (index < tokens.length && isAssignment(tokens[index])) {
    index++;
  }

  return tokens.slice(index).join(" ");
}

function tokenizeWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushWord = () => {
    if (current.length > 0) {
      words.push(current);
      current = "";
    }
  };

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }

    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }

    if (!quote && /\s/.test(char)) {
      pushWord();
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    throw new Error("unterminated quote or escape");
  }

  pushWord();
  return words;
}

function hasFileRedirect(segment: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }

    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }

    if (quote) {
      continue;
    }

    if (char === "&" && segment[index + 1] === ">") {
      if (isSafeAmpersandRedirect(segment, index)) {
        index++;
        continue;
      }
      return true;
    }

    if (char === ">") {
      if (isSafeFdRedirect(segment, index)) {
        continue;
      }
      return true;
    }
  }

  return false;
}

function isSafeAmpersandRedirect(segment: string, ampersandIndex: number): boolean {
  const target = nextRedirectTarget(segment, ampersandIndex + 2);
  return target === "/dev/null";
}

function isSafeFdRedirect(segment: string, greaterThanIndex: number): boolean {
  const fdStart = previousTokenStart(segment, greaterThanIndex - 1);
  const fd = segment.slice(fdStart, greaterThanIndex);
  const previousChar = segment[fdStart - 1] ?? " ";
  const secondGreaterThan = segment[greaterThanIndex + 1] === ">";
  const targetStart = greaterThanIndex + (secondGreaterThan ? 2 : 1);
  const target = nextRedirectTarget(segment, targetStart);

  if (fd === "2" && /\s/.test(previousChar)) {
    return target === "/dev/null" || target === "&1";
  }

  if (segment[greaterThanIndex - 1] === "&") {
    return target === "2";
  }

  return false;
}

function previousTokenStart(segment: string, index: number): number {
  let start = index;
  while (start >= 0 && /\d/.test(segment[start])) {
    start--;
  }
  return start + 1;
}

function nextRedirectTarget(segment: string, index: number): string {
  let cursor = index;
  while (cursor < segment.length && /\s/.test(segment[cursor])) {
    cursor++;
  }

  let target = "";
  while (cursor < segment.length && !/\s/.test(segment[cursor])) {
    target += segment[cursor];
    cursor++;
  }

  return target;
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function block(code: BlockCode, reason: string): BashClassification {
  return { verdict: "block", code, reason };
}

function segmentBlock(
  code: BlockCode,
  reason: string,
  offendingSegment: string,
): Extract<SegmentClassification, { verdict: "block" }> {
  return { verdict: "block", code, reason, offendingSegment };
}
