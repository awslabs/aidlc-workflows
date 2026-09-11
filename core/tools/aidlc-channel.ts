// Release channels and the closed version-id grammar shared by the native
// lifecycle, the release scripts, and the tests. The preview marker is spelled
// here exactly once; the shell installers and the launcher shims carry their own
// literal next to a comment that names PREVIEW_CHANNEL.
//
// Stable ids are exactly `x.y.z`. Preview ids are
// `<x.y.z>-preview.<YYYYMMDD>.<N>`: the source tree's AIDLC_VERSION, the UTC
// build date, and a positive build counter for that date. Nothing else is a
// version anywhere in the install tree, so a version is always a safe directory
// name by construction.
import { AIDLC_VERSION } from "./aidlc-version.ts";

export const STABLE_CHANNEL = "stable";
export const PREVIEW_CHANNEL = "preview";

export type ReleaseChannel = typeof STABLE_CHANNEL | typeof PREVIEW_CHANNEL;

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = [STABLE_CHANNEL, PREVIEW_CHANNEL];

// Environment variable that stamps a release build with a preview id. The
// packager renders every projected aidlc-version.ts copy and projection stamp
// from it; the source tree itself is never modified.
export const BUILD_VERSION_ENV = "AIDLC_BUILD_VERSION";

const NUMBER = "(?:0|[1-9]\\d*)";
const PREVIEW_SUFFIX = `-${PREVIEW_CHANNEL}\\.\\d{8}\\.[1-9]\\d*`;

// Unanchored, capture-free sources for callers that embed the grammar in a
// larger expression (reservation file names, PowerShell shim checks).
export const STABLE_VERSION_PATTERN = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`;
export const PREVIEW_VERSION_PATTERN = `${STABLE_VERSION_PATTERN}${PREVIEW_SUFFIX}`;
export const VERSION_ID_PATTERN = `${STABLE_VERSION_PATTERN}(?:${PREVIEW_SUFFIX})?`;

export const STABLE_VERSION = new RegExp(`^${STABLE_VERSION_PATTERN}$`);
export const PREVIEW_VERSION = new RegExp(`^${PREVIEW_VERSION_PATTERN}$`);
export const VERSION_ID = new RegExp(`^${VERSION_ID_PATTERN}$`);

const PARSED_VERSION = new RegExp(
  `^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-${PREVIEW_CHANNEL}\\.(\\d{8})\\.([1-9]\\d*))?$`,
);

export type ParsedVersion = {
  base: string;
  major: number;
  minor: number;
  patch: number;
  channel: ReleaseChannel;
  date?: string;
  build?: number;
};

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === STABLE_CHANNEL || value === PREVIEW_CHANNEL;
}

export function requireReleaseChannel(value: string): ReleaseChannel {
  if (!isReleaseChannel(value)) {
    throw new Error(
      `invalid release channel "${value}"; expected ${RELEASE_CHANNELS.join(" or ")}`,
    );
  }
  return value;
}

export function requireVersion(value: string): string {
  if (!VERSION_ID.test(value)) {
    throw new Error(
      `invalid version "${value}"; expected x.y.z or x.y.z-${PREVIEW_CHANNEL}.YYYYMMDD.N (for example 2.5.0)`,
    );
  }
  return value;
}

export function parseVersion(value: string): ParsedVersion {
  const match = PARSED_VERSION.exec(requireVersion(value));
  if (!match) throw new Error(`invalid version "${value}"`);
  const [, major, minor, patch, date, build] = match;
  return {
    base: `${major}.${minor}.${patch}`,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    channel: date === undefined ? STABLE_CHANNEL : PREVIEW_CHANNEL,
    ...(date === undefined ? {} : { date, build: Number(build) }),
  };
}

export function versionChannel(value: string): ReleaseChannel {
  return parseVersion(value).channel;
}

// Total order over version ids. Numeric on x.y.z; at an equal base the stable
// release sorts after every preview built from that base (a preview is built
// from main before the same version is blessed); previews order by build date
// then build counter.
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.channel !== b.channel) return a.channel === STABLE_CHANNEL ? 1 : -1;
  if (a.channel === STABLE_CHANNEL) return 0;
  if (a.date !== b.date) return (a.date as string) < (b.date as string) ? -1 : 1;
  const aBuild = a.build as number;
  const bBuild = b.build as number;
  return aBuild === bBuild ? 0 : aBuild < bBuild ? -1 : 1;
}

export function utcBuildDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

export function previewVersion(base: string, date: string, build: number): string {
  if (!STABLE_VERSION.test(base)) {
    throw new Error(`preview base must be a stable x.y.z version, got "${base}"`);
  }
  if (!/^\d{8}$/.test(date)) {
    throw new Error(`preview build date must be YYYYMMDD, got "${date}"`);
  }
  if (!Number.isSafeInteger(build) || build < 1) {
    throw new Error(`preview build counter must be a positive integer, got ${String(build)}`);
  }
  return requireVersion(`${base}-${PREVIEW_CHANNEL}.${date}.${build}`);
}

// The version a release build stamps into its artifacts. Unset or equal to the
// source version means an ordinary stable build; a preview id must be built from
// exactly the source tree's AIDLC_VERSION so `x.y.z` in the id is never a lie.
export function releaseBuildVersion(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[BUILD_VERSION_ENV]?.trim();
  if (!configured || configured === AIDLC_VERSION) return AIDLC_VERSION;
  const parsed = parseVersion(configured);
  if (parsed.channel !== PREVIEW_CHANNEL) {
    throw new Error(
      `${BUILD_VERSION_ENV} must be unset, ${AIDLC_VERSION}, or a ${PREVIEW_CHANNEL} id built from it; got "${configured}"`,
    );
  }
  if (parsed.base !== AIDLC_VERSION) {
    throw new Error(
      `${BUILD_VERSION_ENV} "${configured}" is not built from source version ${AIDLC_VERSION}`,
    );
  }
  return configured;
}
