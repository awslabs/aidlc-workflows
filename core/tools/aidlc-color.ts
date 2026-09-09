type ColorStream = {
  isTTY?: boolean;
};

let explicitNoColor = false;
let decisions = new WeakMap<object, boolean>();

export function configureColor(argv: readonly string[]): void {
  explicitNoColor = argv.includes("--no-color");
  decisions = new WeakMap<object, boolean>();
}

export function colorEnabled(stream: ColorStream): boolean {
  const key = stream as object;
  const cached = decisions.get(key);
  if (cached !== undefined) return cached;
  const force = process.env.FORCE_COLOR;
  const enabled = !explicitNoColor &&
    !Object.hasOwn(process.env, "NO_COLOR") &&
    (
      (typeof force === "string" && force.length > 0 && force !== "0") ||
      (stream.isTTY === true && process.env.TERM !== "dumb")
    );
  decisions.set(key, enabled);
  return enabled;
}

function sgr(value: string, code: number, stream: ColorStream): string {
  return colorEnabled(stream)
    ? `\x1b[${code}m${value}\x1b[0m`
    : value;
}

export function heading(value: string, stream: ColorStream): string {
  return sgr(value, 1, stream);
}

export function cmd(value: string, stream: ColorStream): string {
  return sgr(value, 1, stream);
}

export function okVerdict(value: string, _stream: ColorStream): string {
  return value;
}

export function warnVerdict(value: string, stream: ColorStream): string {
  return sgr(value, 33, stream);
}

export function failVerdict(value: string, stream: ColorStream): string {
  return sgr(value, 31, stream);
}

export function errorLabel(value: string, stream: ColorStream): string {
  return sgr(value, 31, stream);
}

export function tipLabel(value: string, stream: ColorStream): string {
  return sgr(value, 36, stream);
}

export function fixLabel(value: string, stream: ColorStream): string {
  return sgr(value, 36, stream);
}

export function success(value: string, stream: ColorStream): string {
  return sgr(value, 32, stream);
}

export function dim(value: string, stream: ColorStream): string {
  return sgr(value, 2, stream);
}
