// Loaded only by Windows Bun: Node clients use the PowerShell security APIs.
import { resolve, win32 } from "node:path";
import type { Pointer } from "bun:ffi";
// bun:ffi does not exist in Node or support these DLLs on POSIX.
const { dlopen, ptr, read } = await import("bun:ffi");

const kernel = dlopen("kernel32.dll", {
  GetCurrentProcess: { args: [], returns: "u64" },
  GetFileAttributesW: { args: ["ptr"], returns: "u32" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  LocalFree: { args: ["ptr"], returns: "ptr" },
  GetLastError: { args: [], returns: "u32" },
}).symbols;
const security = dlopen("advapi32.dll", {
  GetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  SetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
  GetTokenInformation: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  EqualSid: { args: ["ptr", "ptr"], returns: "i32" },
  IsWellKnownSid: { args: ["ptr", "i32"], returns: "i32" },
  GetAclInformation: { args: ["ptr", "ptr", "u32", "u32"], returns: "i32" },
  GetAce: { args: ["ptr", "u32", "ptr"], returns: "i32" },
}).symbols;

export function validateWindowsPrivatePath(path: string): void {
  const fail = (reason: string): never => { throw new Error(`${reason} (${path}; Windows error ${kernel.GetLastError()})`); };
  const name = Buffer.from(`${win32.toNamespacedPath(resolve(path))}\0`, "utf16le");
  const attributes = kernel.GetFileAttributesW(name);
  if (attributes === 0xffffffff) fail("cannot read file attributes");
  if ((attributes & 0x400) !== 0) fail("reparse point is not allowed");
  const owner = new BigUint64Array(1);
  const dacl = new BigUint64Array(1);
  const descriptor = new BigUint64Array(1);
  const token = new BigUint64Array(1);
  const pointer = (buffer: BigUint64Array): Pointer | null => (read.ptr(ptr(buffer)) || null) as Pointer | null;
  let tokenHandle: Pointer | null = null;
  try {
    // SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION.
    const result = security.GetNamedSecurityInfoW(name, 1, 5, owner, null, dacl, null, descriptor);
    if (result !== 0) fail(`cannot read owner/DACL: ${result}`);
    if (!security.OpenProcessToken(kernel.GetCurrentProcess(), 8, token)) fail("cannot open current process token");
    tokenHandle = pointer(token);
    const size = new Uint32Array(1);
    security.GetTokenInformation(tokenHandle, 1, null, 0, size); // TokenUser size query.
    if (!size[0]) fail("cannot size current user SID");
    const user = new Uint8Array(size[0]);
    if (!security.GetTokenInformation(tokenHandle, 1, user, user.length, size)) fail("cannot read current user SID");
    if (!security.EqualSid(pointer(owner), read.ptr(ptr(user)) as Pointer)) fail("owner SID differs from current user");
    const acl = pointer(dacl);
    if (!acl) fail("null DACL allows public access");
    const info = new Uint32Array(3); // ACL_SIZE_INFORMATION: AceCount, AclBytesInUse, AclBytesFree.
    if (!security.GetAclInformation(acl, info, info.byteLength, 2)) fail("cannot inspect DACL");
    const aceBuffer = new BigUint64Array(1);
    for (let i = 0; i < info[0]; i++) {
      if (!security.GetAce(acl, i, aceBuffer)) fail("cannot read DACL ACE");
      const ace = pointer(aceBuffer);
      if (!ace) fail("missing DACL ACE");
      const type = read.u8(ace!);
      // Include inherited, callback and object allow ACEs, even inherit-only ones.
      if (![0, 5, 9, 11].includes(type)) continue;
      let offset = 8;
      if (type === 5 || type === 11) {
        const flags = read.u32(ace!, 8);
        offset = 12 + ((flags & 1) ? 16 : 0) + ((flags & 2) ? 16 : 0);
      }
      const sid = (Number(ace) + offset) as Pointer;
      // WinWorldSid, WinAuthenticatedUserSid, WinBuiltinUsersSid; SID-based,
      // unlike icacls text this also handles localized Windows account names.
      if ([1, 17, 27].some((kind) => security.IsWellKnownSid(sid, kind))) {
        fail("public allow ACE (Everyone, BUILTIN\\Users or Authenticated Users)");
      }
    }
  } finally {
    if (tokenHandle) kernel.CloseHandle(tokenHandle);
    const allocation = pointer(descriptor);
    if (allocation) kernel.LocalFree(allocation);
  }
}

/** Only for the unpublished file just opened with O_EXCL in a private parent. */
export function ownWindowsPrivateFile(path: string): void {
  const token = new BigUint64Array(1);
  if (!security.OpenProcessToken(kernel.GetCurrentProcess(), 8, token)) throw new Error("cannot open current user token");
  const handle = read.ptr(ptr(token)) as Pointer;
  try {
    const size = new Uint32Array(1);
    security.GetTokenInformation(handle, 1, null, 0, size);
    if (!size[0]) throw new Error("cannot size current user SID");
    const user = new Uint8Array(size[0]);
    if (!security.GetTokenInformation(handle, 1, user, user.length, size)) throw new Error("cannot read current user SID");
    const result = security.SetNamedSecurityInfoW(
      Buffer.from(`${win32.toNamespacedPath(resolve(path))}\0`, "utf16le"),
      1, 1, read.ptr(ptr(user)) as Pointer, null, null, null,
    );
    if (result !== 0) throw new Error(`cannot set new private file owner: Windows error ${result} (${path})`);
  } finally { kernel.CloseHandle(handle); }
}
