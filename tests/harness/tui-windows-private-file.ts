// Loaded only by Windows Bun: Node clients use the PowerShell security APIs.
import { resolve, win32 } from "node:path";
import type { Pointer } from "bun:ffi";
// bun:ffi does not exist in Node or support these DLLs on POSIX.
const { dlopen, ptr, read } = await import("bun:ffi");

const kernel = dlopen("kernel32.dll", {
  GetCurrentProcess: { args: [], returns: "u64" },
  GetFileAttributesW: { args: ["ptr"], returns: "u32" },
  CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
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
  GetLengthSid: { args: ["ptr"], returns: "u32" },
  InitializeAcl: { args: ["ptr", "u32", "u32"], returns: "i32" },
  AddAccessAllowedAceEx: { args: ["ptr", "u32", "u32", "u32", "ptr"], returns: "i32" },
  InitializeSecurityDescriptor: { args: ["ptr", "u32"], returns: "i32" },
  SetSecurityDescriptorOwner: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  SetSecurityDescriptorDacl: { args: ["ptr", "i32", "ptr", "i32"], returns: "i32" },
  SetSecurityDescriptorControl: { args: ["ptr", "u16", "u16"], returns: "i32" },
}).symbols;

// The primary user SID is immutable for this process. Retain the TOKEN_USER
// buffer so its interior SID pointer remains alive, and close the token once.
const currentUser = (() => {
  const token = new BigUint64Array(1);
  if (!security.OpenProcessToken(kernel.GetCurrentProcess(), 8, token)) throw new Error("cannot open current user token");
  const handle = read.ptr(ptr(token)) as Pointer;
  try {
    const size = new Uint32Array(1);
    security.GetTokenInformation(handle, 1, null, 0, size);
    if (!size[0]) throw new Error("cannot size current user SID");
    const buffer = new Uint8Array(size[0]);
    if (!security.GetTokenInformation(handle, 1, buffer, buffer.length, size)) throw new Error("cannot read current user SID");
    return buffer;
  } finally { kernel.CloseHandle(handle); }
})();
const currentUserSid = read.ptr(ptr(currentUser)) as Pointer;

const privateDirectorySecurity = (() => {
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("Windows private directories require 64-bit Bun");
  // ACL header (8), ACCESS_ALLOWED_ACE header/mask (8), then the variable SID.
  const acl = new Uint8Array(16 + security.GetLengthSid(currentUserSid));
  const descriptor = new Uint8Array(40); // Absolute SECURITY_DESCRIPTOR, Win64.
  if (!security.InitializeAcl(acl, acl.length, 2) ||
    !security.AddAccessAllowedAceEx(acl, 2, 3, 0x1f01ff, currentUserSid) || // OI|CI, FILE_ALL_ACCESS
    !security.InitializeSecurityDescriptor(descriptor, 1) ||
    !security.SetSecurityDescriptorOwner(descriptor, currentUserSid, 0) ||
    !security.SetSecurityDescriptorDacl(descriptor, 1, acl, 0) ||
    !security.SetSecurityDescriptorControl(descriptor, 0x1000, 0x1000)) { // SE_DACL_PROTECTED
    throw new Error(`cannot initialize private directory security: Windows error ${kernel.GetLastError()}`);
  }
  const attributes = new Uint8Array(24); // SECURITY_ATTRIBUTES; non-inheritable handle.
  const view = new DataView(attributes.buffer);
  view.setUint32(0, attributes.length, true);
  view.setBigUint64(8, BigInt(ptr(descriptor)), true);
  return { user: currentUser, acl, descriptor, attributes }; // Retain buffers referenced by native pointers.
})();

/** Apply owner and protected DACL in the create syscall, never repair EEXIST. */
export function createWindowsPrivateDirectory(path: string): void {
  if (!kernel.CreateDirectoryW(
    Buffer.from(`${win32.toNamespacedPath(resolve(path))}\0`, "utf16le"), privateDirectorySecurity.attributes,
  )) {
    const code = kernel.GetLastError();
    if (code !== 183) throw new Error(`cannot create private directory: Windows error ${code} (${path})`);
  }
}

export function validateWindowsPrivatePath(path: string): void {
  const fail = (reason: string): never => { throw new Error(`${reason} (${path}; Windows error ${kernel.GetLastError()})`); };
  const name = Buffer.from(`${win32.toNamespacedPath(resolve(path))}\0`, "utf16le");
  const attributes = kernel.GetFileAttributesW(name);
  if (attributes === 0xffffffff) fail("cannot read file attributes");
  if ((attributes & 0x400) !== 0) fail("reparse point is not allowed");
  const owner = new BigUint64Array(1);
  const dacl = new BigUint64Array(1);
  const descriptor = new BigUint64Array(1);
  const pointer = (buffer: BigUint64Array): Pointer | null => (read.ptr(ptr(buffer)) || null) as Pointer | null;
  try {
    // SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION.
    const result = security.GetNamedSecurityInfoW(name, 1, 5, owner, null, dacl, null, descriptor);
    if (result !== 0) fail(`cannot read owner/DACL: ${result}`);
    if (!security.EqualSid(pointer(owner), currentUserSid)) fail("owner SID differs from current user");
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
    const allocation = pointer(descriptor);
    if (allocation) kernel.LocalFree(allocation);
  }
}

/** Only for the unpublished file just opened with O_EXCL in a private parent. */
export function ownWindowsPrivateFile(path: string): void {
  const result = security.SetNamedSecurityInfoW(
    Buffer.from(`${win32.toNamespacedPath(resolve(path))}\0`, "utf16le"),
    1, 1, currentUserSid, null, null, null,
  );
  if (result !== 0) throw new Error(`cannot set new private file owner: Windows error ${result} (${path})`);
}
