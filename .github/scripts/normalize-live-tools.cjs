// Windows npm installers may hard-link their executable into another package
// path. Run as the installer identity, before the runner seals the tools: copy
// only bytes that identity can read, without changing any outside link's ACLs.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function assertPlainPath(target) {
  for (let cursor = path.resolve(target); ; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error("Refusing a linked installed-tool path.");
    }
    if (path.dirname(cursor) === cursor) break;
  }
}

function normalizeTools(root) {
  assertPlainPath(root);
  if (!fs.lstatSync(root).isDirectory()) throw new Error("Expected an installed-tool directory.");
  let copies = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  function visit(target) {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("Refusing a linked installed tool.");
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (!info.isFile()) throw new Error("Refusing a non-file installed tool.");
    if (info.nlink === 1) return;
    let source = fs.openSync(target, "r");
    const temporary = path.join(path.dirname(target), `.aidlc-unlink-${randomUUID()}.tmp`);
    let created = false;
    try {
      const opened = fs.fstatSync(source);
      if (!opened.isFile()) throw new Error("Installed tool changed during normalization.");
      const output = fs.openSync(temporary, "wx", opened.mode & 0o777);
      created = true;
      try {
        for (;;) {
          const read = fs.readSync(source, buffer, 0, buffer.length, null);
          if (read === 0) break;
          let written = 0;
          while (written < read) {
            const count = fs.writeSync(output, buffer, written, read - written);
            if (count === 0) throw new Error("Could not write the installed-tool copy.");
            written += count;
          }
        }
      } finally { fs.closeSync(output); }
      fs.closeSync(source);
      source = undefined;
      // Replace the directory entry, never the shared file's contents or ACL.
      fs.renameSync(temporary, target);
      created = false;
      copies++;
    } finally {
      if (source !== undefined) fs.closeSync(source);
      if (created) fs.unlinkSync(temporary);
    }
  }
  visit(root);
  return copies;
}

module.exports = { normalizeTools };
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Expected the installed-tool root.");
    console.log(`Normalized ${normalizeTools(process.argv[2])} hard-linked tool files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
