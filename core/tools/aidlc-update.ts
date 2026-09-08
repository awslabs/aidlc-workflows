import { existsSync, readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import {
  machineTransactionRoot,
  requireVersion,
} from "./aidlc-install-paths.ts";
import {
  type MachineConfig,
  readMachineConfig,
  resolvedReleaseSettings,
  updateCachePath,
} from "./aidlc-machine-config.ts";
import {
  fetchReleaseMetadata,
  ReleaseUnavailableError,
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
  latestVersion?: string;
  checkedAt?: string;
  stale?: boolean;
  message: string;
};

function compareSemver(left: string, right: string): number {
  const a = requireVersion(left).split(".").map(Number);
  const b = requireVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function validateCache(value: unknown): UpdateCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("update cache must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "checkedAt", "latestVersion", "releaseDate"]);
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
    !/^\d{4}-\d{2}-\d{2}$/.test(record.releaseDate)
  ) {
    throw new Error("update cache has an invalid schema");
  }
  requireVersion(record.latestVersion);
  return record as UpdateCache;
}

export function readUpdateCache(): UpdateCache | null {
  const path = updateCachePath();
  if (!existsSync(path)) return null;
  return validateCache(JSON.parse(readFileSync(path, "utf-8")));
}

function cacheState(cache: UpdateCache, now = Date.now()): UpdateState {
  const stale = now - Date.parse(cache.checkedAt) >= CACHE_TTL_MS;
  const behind = compareSemver(AIDLC_VERSION, cache.latestVersion) < 0;
  return {
    state: behind ? "behind" : stale ? "stale" : "current",
    currentVersion: AIDLC_VERSION,
    latestVersion: cache.latestVersion,
    checkedAt: cache.checkedAt,
    stale,
    message: behind
      ? `binary ${AIDLC_VERSION}, latest ${cache.latestVersion}`
      : stale
      ? `binary ${AIDLC_VERSION}; update cache is stale`
      : `binary ${AIDLC_VERSION} is latest`,
  };
}

export function cachedUpdateState(): UpdateState {
  let config: MachineConfig;
  try {
    config = readMachineConfig();
  } catch (error) {
    return {
      state: "invalid-config",
      currentVersion: AIDLC_VERSION,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (config["update-check"] === false) {
    return {
      state: "disabled",
      currentVersion: AIDLC_VERSION,
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
      message: "update cache is invalid",
    };
  }
  if (cache) return cacheState(cache);
  return {
    state: settings.offline ? "offline" : "absent",
    currentVersion: AIDLC_VERSION,
    message: settings.offline ? "update check unavailable while offline" : "update cache is absent",
  };
}

export function cachedUpdateNotice(): string | null {
  const state = cachedUpdateState();
  return state.state === "behind" && state.latestVersion
    ? `Update available: aidlc ${state.latestVersion} (current ${AIDLC_VERSION}). Update with: ${aidlcInvocation()} update`
    : null;
}

export async function refreshUpdateState(
  timeoutMs: number,
  overrides: {
    offline?: boolean;
    baseUrl?: string;
    caBundle?: string;
  } = {},
): Promise<UpdateState> {
  let config: MachineConfig;
  try {
    config = readMachineConfig();
  } catch (error) {
    return {
      state: "invalid-config",
      currentVersion: AIDLC_VERSION,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (config["update-check"] === false) return cachedUpdateState();
  const settings = resolvedReleaseSettings(overrides);
  if (settings.offline) {
    return {
      state: "offline",
      currentVersion: AIDLC_VERSION,
      message: "update check unavailable while offline",
    };
  }
  let release: Awaited<ReturnType<typeof fetchReleaseMetadata>> | null = null;
  try {
    release = await fetchReleaseMetadata({
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
    });
    const previousCache = (() => {
      try {
        return readUpdateCache();
      } catch {
        return null;
      }
    })();
    if (
      compareSemver(cache.latestVersion, AIDLC_VERSION) < 0 ||
      previousCache &&
        compareSemver(cache.latestVersion, previousCache.latestVersion) < 0
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
    const previous = cachedUpdateState();
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
      message: error instanceof ReleaseUnavailableError
        ? error.message
        : `update refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (release?.cleanup) rmSync(release.cleanup, { recursive: true, force: true });
  }
}
