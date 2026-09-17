import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";

export type ArchiveEntry = {
  path: string;
  type: "file" | "directory";
  mode: number;
  data: Buffer;
};

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

function octal(buffer: Buffer, start: number, length: number): number {
  const value = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`invalid tar octal field "${value}"`);
  return Number.parseInt(value, 8);
}

function safePath(value: string): string {
  const slashPath = value.replaceAll("\\", "/");
  const normalized = posix.normalize(slashPath);
  if (
    !value ||
    value.includes("\0") ||
    slashPath.split("/").some((segment) => segment === "." || segment === "..") ||
    isAbsolute(value) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(`unsafe archive path: ${JSON.stringify(value)}`);
  }
  return normalized.replace(/\/$/, "");
}

export function readTarGz(
  path: string,
  options: { maxBytes?: number } = {},
): ArchiveEntry[] {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARCHIVE_BYTES) {
    throw new Error("archive byte limit must be a positive integer no greater than 1 GiB");
  }
  if (statSync(path).size > maxBytes) {
    throw new Error("compressed archive exceeds the archive byte limit");
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(readFileSync(path), { maxOutputLength: maxBytes });
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new Error("expanded archive exceeds the extraction byte limit");
    }
    throw error;
  }
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stored = octal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actual = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (stored !== actual) throw new Error(`tar header checksum mismatch at byte ${offset}`);
    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf-8").replace(/\0.*$/, "");
    const entryPath = safePath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(entryPath)) throw new Error(`duplicate archive destination: ${entryPath}`);
    seen.add(entryPath);
    const size = octal(header, 124, 12);
    const mode = octal(header, 100, 8) || 0o644;
    const typeFlag = String.fromCharCode(header[156] || 0);
    if (!["\0", "0", "5"].includes(typeFlag)) {
      throw new Error(`archive entry ${entryPath} has unsupported link/special type ${typeFlag}`);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`truncated archive entry: ${entryPath}`);
    if (typeFlag === "5" && size !== 0) {
      throw new Error(`archive directory ${entryPath} has unexpected file data`);
    }
    entries.push({
      path: entryPath,
      type: typeFlag === "5" ? "directory" : "file",
      mode,
      data: Buffer.from(tar.subarray(dataStart, dataEnd)),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  const types = new Map(entries.map((entry) => [entry.path, entry.type]));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/");
      if (types.get(ancestor) === "file") {
        throw new Error(`archive file ${ancestor} is an ancestor of ${entry.path}`);
      }
    }
  }
  return entries;
}

export function extractTarGz(
  path: string,
  destination: string,
  options: { reservedTopLevelNames?: readonly string[] } = {},
): void {
  const entries = readTarGz(path);
  const reserved = new Set(
    (options.reservedTopLevelNames ?? []).map((name) => name.toLowerCase()),
  );
  for (const entry of entries) {
    const topLevel = entry.path.split("/", 1)[0].toLowerCase();
    if (reserved.has(topLevel)) {
      throw new Error(`archive entry uses reserved top-level name: ${entry.path}`);
    }
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries.filter((item) => item.type === "directory")) {
    mkdirSync(join(destination, entry.path), { recursive: true, mode: entry.mode & 0o777 });
  }
  for (const entry of entries.filter((item) => item.type === "file")) {
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, entry.data, { mode: entry.mode & 0o777 });
  }
}

function tarString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function tarOctal(header: Buffer, offset: number, length: number, value: number): void {
  tarString(header, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function tarPath(path: string): { name: string; prefix?: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`tar path is too long for ustar: ${path}`);
}

export function createTarGz(entries: readonly ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const types = new Map<string, ArchiveEntry["type"]>();
  for (const source of sorted) {
    const path = safePath(source.path);
    if (source.type === "directory" && source.data.length !== 0) {
      throw new Error(`archive directory ${path} has unexpected file data`);
    }
    if (seen.has(path)) throw new Error(`duplicate archive destination: ${path}`);
    seen.add(path);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/");
      if (types.get(ancestor) === "file") {
        throw new Error(`archive file ${ancestor} is an ancestor of ${path}`);
      }
    }
    types.set(path, source.type);
    const header = Buffer.alloc(512);
    const fields = tarPath(path);
    tarString(header, 0, 100, fields.name);
    if (fields.prefix) tarString(header, 345, 155, fields.prefix);
    tarOctal(header, 100, 8, source.mode & 0o777);
    tarOctal(header, 108, 8, 0);
    tarOctal(header, 116, 8, 0);
    tarOctal(header, 124, 12, source.type === "file" ? source.data.length : 0);
    tarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = source.type === "directory" ? "5".charCodeAt(0) : "0".charCodeAt(0);
    tarString(header, 257, 6, "ustar");
    tarString(header, 263, 2, "00");
    tarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    chunks.push(header);
    if (source.type === "file") {
      chunks.push(source.data);
      const padding = (512 - (source.data.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
