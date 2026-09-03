import { existsSync, readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import {
  compareVersions,
  isReleaseChannel,
  PREVIEW_CHANNEL,
  type ReleaseChannel,
  requireVersion,
  STABLE_CHANNEL,
  versionChannel,
} from "./aidlc-channel.ts";
import { machineTransactionRoot } from "./aidlc-install-paths.ts";
import {
  type MachineConfig,
  readMachineChannel,
  readMachineConfig,
  resolvedReleaseSettings,
  updateCachePath,
} from "./aidlc-machine-config.ts";
import {
  fetchReleaseMetadata,
  ReleaseUnavailableError,
  resolvePreviewVersion,
} from "./aidlc-release.ts";
import {
  executePlan,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";
import { aidlcInvocation } from "./aidlc-runtime-paths.ts";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type UpdateCache = {
  schemaVersion: 1;
  checkedAt: string;
  latestVersion: string;
  releaseDate: string;
  // Caches written before release channels existed carry no channel and
  // describe the stable stream.
  channel?: ReleaseChannel;
};

export type UpdateState = {
  state:
    | "current"
    | "behind"
    | "stale"
    | "disabled"
    | "offline"
    | "unavailable"
    | "absent"
    | "invalid-config";
  currentVersion: string;
  channel: ReleaseChannel;
  latestVersion?: string;
  checkedAt?: string;
  stale?: boolean;
  message: string;
};

function validateCache(value: unknown): UpdateCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("update cache must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "checkedAt", "latestVersion", "releaseDate", "channel"]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`update cache contains unknown key(s): ${unknown.join(", ")}`);
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(record.checkedAt)) ||
    typeof record.latestVersion !== "string" ||
    typeof record.releaseDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record.releaseDate) ||
    (record.channel !== undefined && !isReleaseChannel(record.channel))
  ) {
    throw new Error("update cache has an invalid schema");
  }
  requireVersion(record.latestVersion);
  if (versionChannel(record.latestVersion) !== (record.channel ?? STABLE_CHANNEL)) {
    throw new Error("update cache version does not belong to its channel");
  }
  return record as UpdateCache;
}

export function readUpdateCache(): UpdateCache | null {
  const path = updateCachePath();
  if (!existsSync(path)) return null;
  return validateCache(JSON.parse(readFileSync(path, "utf-8")));
}

// The machine is "behind" when the channel's newest release is newer than the
// running binary, or when the binary belongs to the other channel: a stable
// binary on the preview channel (or the reverse) converges through `update`
// even when the target id sorts lower, and that is a channel switch, not a
// downgrade.
function cacheState(cache: UpdateCache, now = Date.now()): UpdateState {
  const channel = cache.channel ?? STABLE_CHANNEL;
  const binaryChannel = versionChannel(AIDLC_VERSION);
  const stale = now - Date.parse(cache.checkedAt) >= CACHE_TTL_MS;
  const switching = binaryChannel !== channel;
  const behind = switching || compareVersions(AIDLC_VERSION, cache.latestVersion) < 0;
  // Stable messages keep their pre-channel wording; preview names its channel.
  const channelWord = channel === STABLE_CHANNEL ? "" : `${channel} `;
  return {
    state: behind ? "behind" : stale ? "stale" : "current",
    currentVersion: AIDLC_VERSION,
    channel,
    latestVersion: cache.latestVersion,
    checkedAt: cache.checkedAt,
    stale,
    message: switching
      ? `binary ${AIDLC_VERSION} (${binaryChannel}), ${channel} channel newest ${cache.latestVersion}; update switches channels`
      : behind
      ? `binary ${AIDLC_VERSION}, latest ${channelWord}${cache.latestVersion}`
      : stale
      ? `binary ${AIDLC_VERSION}; update cache is stale`
      : `binary ${AIDLC_VERSION} is ${channelWord ? `the latest ${channelWord}release` : "latest"}`,
  };
}

export function cachedUpdateState(requested?: ReleaseChannel): UpdateState {
  let config: MachineConfig;
  let channel: ReleaseChannel;
  try {
    config = readMachineConfig();
    channel = requested ?? readMachineChannel();
  } catch (error) {
    return {
      state: "invalid-config",
      currentVersion: AIDLC_VERSION,
      channel: requested ?? STABLE_CHANNEL,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (config["update-check"] === false) {
    return {
      state: "disabled",
      currentVersion: AIDLC_VERSION,
      channel,
      message: "update checks disabled by global config",
    };
  }
  const settings = resolvedReleaseSettings();
  let cache: UpdateCache | null;
  try {
    cache = readUpdateCache();
  } catch {
    return {
      state: "unavailable",
      currentVersion: AIDLC_VERSION,
      channel,
      message: "update cache is invalid",
    };
  }
  // A cache written for the other channel describes a stream this machine no
  // longer follows; it is not evidence about the selected channel.
  if (cache && (cache.channel ?? STABLE_CHANNEL) === channel) return cacheState(cache);
  return {
    state: settings.offline ? "offline" : "absent",
    currentVersion: AIDLC_VERSION,
    channel,
    message: settings.offline ? "update check unavailable while offline" : "update cache is absent",
  };
}

export function cachedUpdateNotice(): string | null {
  const state = cachedUpdateState();
  return state.state === "behind" && state.latestVersion
    ? `Update available: aidlc ${state.latestVersion} (current ${AIDLC_VERSION}, ${state.channel} channel). Update with: ${aidlcInvocation()} update`
    : null;
}

export async function refreshUpdateState(
  timeoutMs: number,
  overrides: {
    offline?: boolean;
    baseUrl?: string;
    caBundle?: string;
    channel?: ReleaseChannel;
    apiUrl?: string;
  } = {},
): Promise<UpdateState> {
  let config: MachineConfig;
  let channel: ReleaseChannel;
  try {
    config = readMachineConfig();
    channel = overrides.channel ?? readMachineChannel();
  } catch (error) {
    return {
      state: "invalid-config",
      currentVersion: AIDLC_VERSION,
      channel: overrides.channel ?? STABLE_CHANNEL,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (config["update-check"] === false) return cachedUpdateState(channel);
  const settings = resolvedReleaseSettings(overrides);
  if (settings.offline) {
    return {
      state: "offline",
      currentVersion: AIDLC_VERSION,
      channel,
      message: "update check unavailable while offline",
    };
  }
  let release: Awaited<ReturnType<typeof fetchReleaseMetadata>> | null = null;
  try {
    const version = channel === PREVIEW_CHANNEL
      ? await resolvePreviewVersion({
          baseUrl: settings.baseUrl,
          apiUrl: overrides.apiUrl,
          caBundle: settings.caBundle,
          timeoutMs,
        })
      : undefined;
    release = await fetchReleaseMetadata({
      version,
      offline: settings.offline,
      baseUrl: settings.baseUrl,
      caBundle: settings.caBundle,
      metadataTimeoutMs: timeoutMs,
    });
    const cache: UpdateCache = validateCache({
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      latestVersion: release.manifest.version,
      releaseDate: release.manifest.date,
      channel,
    });
    const previousCache = (() => {
      try {
        return readUpdateCache();
      } catch {
        return null;
      }
    })();
    // A stream regresses only against its own channel: the newest stable is
    // expected to sort below a preview binary, and the other channel's cache
    // says nothing about this one.
    if (
      (versionChannel(AIDLC_VERSION) === channel &&
        compareVersions(cache.latestVersion, AIDLC_VERSION) < 0) ||
      (previousCache &&
        (previousCache.channel ?? STABLE_CHANNEL) === channel &&
        compareVersions(cache.latestVersion, previousCache.latestVersion) < 0)
    ) {
      throw new Error(
        `release metadata regressed from ${
          previousCache?.latestVersion ?? AIDLC_VERSION
        } to ${cache.latestVersion}`,
      );
    }
    const path = updateCachePath();
    const root = machineTransactionRoot();
    executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation(
        relative(root, path),
        `${JSON.stringify(cache, null, 2)}\n`,
        transactionState(path),
        0o600,
      )],
    });
    return cacheState(cache);
  } catch (error) {
    const previous = cachedUpdateState(channel);
    if (previous.state === "behind" || previous.state === "current" || previous.state === "stale") {
      return {
        ...previous,
        state: "unavailable",
        message:
          `update refresh unavailable; cached version ${previous.latestVersion} is stale or unverifiable`,
      };
    }
    return {
      state: "unavailable",
      currentVersion: AIDLC_VERSION,
      channel,
      message: error instanceof ReleaseUnavailableError
        ? error.message
        : `update refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (release?.cleanup) rmSync(release.cleanup, { recursive: true, force: true });
  }
}
