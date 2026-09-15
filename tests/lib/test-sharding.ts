export interface ShardSpec {
  index: number;
  total: number;
}

export interface ShardConfig {
  defaultSeconds: number;
  weights: Record<string, number>;
  affinityGroups: string[][];
}

interface WeightedGroup {
  files: string[];
  weight: number;
}

export function parseShardSpec(value: string): ShardSpec {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value);
  if (!match) {
    throw new Error(`--shard requires N/M with positive integers (got: '${value || "<missing>"}')`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index > total) {
    throw new Error(`--shard index must be within 1..${total} (got: '${value}')`);
  }
  return { index, total };
}

export function validateShardConfig(files: string[], config: ShardConfig): void {
  if (!Number.isFinite(config.defaultSeconds) || config.defaultSeconds <= 0) {
    throw new Error("unit shard defaultSeconds must be a positive number");
  }

  const known = new Set(files);
  for (const [file, weight] of Object.entries(config.weights)) {
    if (!known.has(file)) {
      throw new Error(`unit shard weight names missing test file: ${file}`);
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`unit shard weight must be positive for ${file}`);
    }
  }

  const grouped = new Set<string>();
  for (const group of config.affinityGroups) {
    if (group.length < 2) {
      throw new Error("unit shard affinity groups must contain at least two files");
    }
    for (const file of group) {
      if (!known.has(file)) {
        throw new Error(`unit shard affinity group names missing test file: ${file}`);
      }
      if (grouped.has(file)) {
        throw new Error(`unit shard affinity file appears more than once: ${file}`);
      }
      grouped.add(file);
    }
  }
}

export function assignWeightedShards(
  files: string[],
  total: number,
  config: ShardConfig,
): string[][] {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`unit shard count must be a positive integer (got: ${total})`);
  }

  validateShardConfig(files, config);
  const originalOrder = new Map(files.map((file, index) => [file, index]));
  const assigned = new Set<string>();
  const groups: WeightedGroup[] = [];

  for (const affinity of config.affinityGroups) {
    const members = affinity.filter((file) => originalOrder.has(file));
    for (const file of members) assigned.add(file);
    groups.push({
      files: members,
      weight: members.reduce(
        (sum, file) => sum + (config.weights[file] ?? config.defaultSeconds),
        0,
      ),
    });
  }

  for (const file of files) {
    if (assigned.has(file)) continue;
    groups.push({
      files: [file],
      weight: config.weights[file] ?? config.defaultSeconds,
    });
  }

  if (total > groups.length) {
    throw new Error(
      `--shard count ${total} exceeds ${groups.length} assignable unit-test groups`,
    );
  }

  groups.sort(
    (a, b) => b.weight - a.weight || a.files[0].localeCompare(b.files[0]),
  );

  const shards = Array.from({ length: total }, (_, index) => ({
    index,
    weight: 0,
    files: [] as string[],
  }));
  for (const group of groups) {
    const target = [...shards].sort(
      (a, b) => a.weight - b.weight || a.index - b.index,
    )[0];
    target.files.push(...group.files);
    target.weight += group.weight;
  }

  return shards.map((shard) =>
    shard.files.sort(
      (a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0),
    ),
  );
}

export function selectShard(
  files: string[],
  spec: ShardSpec,
  config: ShardConfig,
): string[] {
  return assignWeightedShards(files, spec.total, config)[spec.index - 1];
}
