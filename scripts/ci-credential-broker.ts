import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "../core/tools/aidlc-runtime-budget.ts";

/** CI-only provider pins; shipped settings intentionally contain no provider configuration. */
export const CI_BEDROCK_MODELS = Object.freeze({
  claude: Object.freeze({
    ANTHROPIC_DEFAULT_FABLE_MODEL: "global.anthropic.claude-fable-5[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-4-8[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  }),
  codex: "openai.gpt-5.5",
  opencode: "global.anthropic.claude-sonnet-4-6",
});

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
}

const ALLOWED_MODELS: Readonly<Record<string, true>> = Object.fromEntries([
  ...Object.values(CI_BEDROCK_MODELS.claude).map((model) => model.replace(/\[1m\]$/, "")),
  CI_BEDROCK_MODELS.codex,
  CI_BEDROCK_MODELS.opencode,
].map(model => [model, true]));
const HOP_BY_HOP: Readonly<Record<string, true>> = {
  connection: true, "keep-alive": true, "proxy-authenticate": true, "proxy-authorization": true,
  te: true, trailer: true, "transfer-encoding": true, upgrade: true,
};
const CREDENTIAL_HEADERS: Readonly<Record<string, true>> = {
  authorization: true, cookie: true, "set-cookie": true, "x-api-key": true, "x-aidlc-broker-token": true,
};

function validateCredentials(value: unknown): Credentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid broker credentials");
  }
  const fields = value as Record<string, unknown>;
  for (const name of ["accessKeyId", "secretAccessKey", "sessionToken", "region"] as const) {
    if (typeof fields[name] !== "string" || !/^[\x21-\x7e]+$/.test(fields[name])) {
      throw new Error("Invalid broker credentials");
    }
  }
  const { accessKeyId, secretAccessKey, sessionToken, region } = fields as unknown as Credentials;
  if (!/^[A-Za-z0-9]+$/.test(accessKeyId) || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) {
    throw new Error("Invalid broker credentials");
  }
  return { accessKeyId, secretAccessKey, sessionToken, region };
}

function upstreamUrl(override: string | undefined, service: "bedrock-runtime" | "bedrock-mantle" | "sts", region: string): URL {
  if (override === undefined) {
    const suffix = service === "bedrock-mantle" ? "api.aws" : "amazonaws.com";
    return new URL(`https://${service}.${region}.${suffix}`);
  }
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error("Invalid loopback upstream");
  }
  // Literal addresses only: no DNS rebinding or userinfo/path-based destination changes.
  if (!["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid loopback upstream");
  }
  return url;
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(search: string): string {
  if (!search) return "";
  return search.slice(1).split("&").filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    const name = decodeURIComponent(separator < 0 ? part : part.slice(0, separator));
    const value = decodeURIComponent(separator < 0 ? "" : part.slice(separator + 1));
    // A second authentication scheme must never compete with the broker's signature.
    if (/^(?:x-amz-|authorization$|x-aidlc-broker-token$)/i.test(name)) {
      throw new Error("Disallowed query parameter");
    }
    // Query strings are URI encoded, not form encoded: a literal '+' is not a space.
    return [uriEncode(name), uriEncode(value)] as const;
  }).sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }).map(([name, value]) => `${name}=${value}`).join("&");
}

function forwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  const connection = new Set((source.get("connection") ?? "").toLowerCase().split(",").map(value => value.trim()));
  for (const [name, value] of source) {
    if (!Object.hasOwn(HOP_BY_HOP, name) && !connection.has(name) && !Object.hasOwn(CREDENTIAL_HEADERS, name) &&
        !name.startsWith("x-amz-") && name !== "host" && name !== "content-length") {
      headers.set(name, value);
    }
  }
  return headers;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signRequest(
  url: URL,
  query: string,
  body: Buffer,
  headers: Headers,
  credentials: Credentials,
  service: "sts" | "bedrock" | "bedrock-mantle",
): void {
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${credentials.region}/${service}/aws4_request`;
  const payloadHash = sha256(body);
  headers.set("host", url.host);
  headers.set("x-amz-date", timestamp);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-security-token", credentials.sessionToken);
  const names = ["host", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token"];
  if (headers.has("content-type")) names.unshift("content-type");
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map(name => `${name}:${headers.get(name)!.trim().replace(/\s+/g, " ")}\n`).join("");
  // Non-S3 SigV4 double-encodes the wire path. Route validation admits only fixed
  // inference paths (no dot segments, embedded slashes or empty segments).
  const path = url.pathname.split("/").map(uriEncode).join("/");
  const canonical = ["POST", path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), credentials.region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
}

function sendRequest(url: URL, body: Buffer, headers: Headers, signal: AbortSignal): Promise<IncomingMessage> {
  // node:http(s) never follows redirects, decompresses responses, consults HTTP_PROXY,
  // or enables Bun fetch's environment-controlled verbose credential logging.
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const options = { method: "POST", headers: Object.fromEntries(headers), signal };
  const request = url.protocol === "https:"
    ? httpsRequest(url, { ...options, rejectUnauthorized: true }, resolve)
    : httpRequest(url, options, resolve);
  request.once("error", () => reject(new Error("Upstream request failed")));
  request.end(body);
  return promise;
}

async function callerIdentity(credentials: Credentials, url: URL): Promise<{ account: string; arn: string }> {
  const body = Buffer.from("Action=GetCallerIdentity&Version=2011-06-15");
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  signRequest(url, "", body, headers, credentials, "sts");
  const response = await sendRequest(url, body, headers, AbortSignal.timeout(DEFAULT_SUBPROCESS_TIMEOUT_MS));
  try {
    if (response.statusCode !== 200) throw new Error("Credential identity verification failed");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 65_536) throw new Error("Invalid credential identity response");
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const xml = Buffer.concat(chunks).toString("utf8");
    const result = xml.match(/<GetCallerIdentityResult>([\s\S]*?)<\/GetCallerIdentityResult>/)?.[1] ?? "";
    const account = result.match(/<Account>(\d{12})<\/Account>/)?.[1];
    const arn = result.match(/<Arn>([^<]+)<\/Arn>/)?.[1];
    if (!account || !arn || arn.length > 2048 ||
        !new RegExp(`^arn:aws(?:-[a-z]+)*:(?:iam|sts)::${account}:[A-Za-z0-9+=,.@_/:-]+$`).test(arn)) {
      throw new Error("Invalid credential identity response");
    }
    return { account, arn };
  } finally {
    response.destroy();
  }
}

const AWS_ERROR_TYPES = new Set([
  "AccessDenied", "AccessDeniedException", "IncompleteSignature", "IncompleteSignatureException",
  "InvalidSignatureException", "SignatureDoesNotMatch", "ExpiredToken", "ExpiredTokenException",
  "InvalidClientTokenId", "UnrecognizedClientException", "MissingAuthenticationToken",
  "MissingAuthenticationTokenException", "ValidationException", "ResourceNotFoundException",
  "ThrottlingException", "InternalServerException", "ServiceUnavailableException",
]);
const INFERENCE_ACTIONS = new Set([
  "bedrock-mantle:CreateInference", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream",
]);
const ERROR_BODY_LIMIT = 8192;
// Optional error-detail collection must promptly fall back to the known error
// class. This does not limit credential verification or model execution.
const ERROR_BODY_TIMEOUT_MS = 1000;

interface UpstreamDiagnostic {
  errorType?: string;
  deniedAction?: string;
}

/** Duplicate or oversized headers are unusable, even if node:http merged them. */
function diagnosticHeader(response: IncomingMessage, name: string): string | null | undefined {
  let value: string | undefined;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index].toLowerCase() !== name) continue;
    if (value !== undefined || response.rawHeaders[index + 1].length > 128) return null;
    value = response.rawHeaders[index + 1];
  }
  return value;
}

/** Emit only known class names, never arbitrary header/type suffixes or namespaces. */
function awsErrorType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  const match = /^(?:[A-Za-z0-9_.]+#)?([A-Za-z][A-Za-z0-9]*)$/.exec(value);
  return match && match[0] === value && AWS_ERROR_TYPES.has(match[1]) ? match[1] : undefined;
}

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deniedInferenceAction(message: unknown): string | undefined {
  if (typeof message !== "string" ||
      !/^(?:User: [^\r\n]{1,2048} is )?not authorized to perform: /.test(message)) return undefined;
  const actions = [...message.matchAll(/(?:^|\s)not authorized to perform: ([a-z-]+:[A-Za-z]+)(?=\s|$|[.,;])/g)]
    .map(match => match[1]);
  return actions.length === 1 && INFERENCE_ACTIONS.has(actions[0]) ? actions[0] : undefined;
}

/** Error bodies can echo signatures/tokens: inspect bounded JSON, emit only enums. */
async function upstreamDiagnostic(response: IncomingMessage): Promise<UpstreamDiagnostic> {
  const headerType = awsErrorType(diagnosticHeader(response, "x-amzn-errortype"));
  const fallback: UpstreamDiagnostic = headerType ? { errorType: headerType } : {};
  // A typed non-permission error needs no body. Only authentication/authorization
  // statuses warrant inspecting a body for a missing class or denied action.
  if (![400, 401, 403].includes(response.statusCode ?? 0) ||
      (headerType && headerType !== "AccessDenied" && headerType !== "AccessDeniedException")) return fallback;
  const contentType = diagnosticHeader(response, "content-type");
  const encoding = diagnosticHeader(response, "content-encoding");
  const length = diagnosticHeader(response, "content-length");
  if (typeof contentType !== "string" ||
      !/^application\/(?:json|x-amz-json-1\.[01])(?:;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(contentType) ||
      (encoding !== undefined && encoding !== "identity") ||
      (length !== undefined && (typeof length !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > ERROR_BODY_LIMIT))) {
    return fallback;
  }
  const timeout = setTimeout(() => response.destroy(), ERROR_BODY_TIMEOUT_MS);
  timeout.unref();
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > ERROR_BODY_LIMIT) return fallback;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!jsonRecord(payload)) return fallback;
    const error = jsonRecord(payload.error) ? payload.error : payload;
    const types = new Set([headerType, ...[payload, error].flatMap(record =>
      [record.__type, record.code, record.Code, record.type].map(awsErrorType))].filter(type => type !== undefined));
    // Conflicting class fields cannot establish which action was denied.
    if (types.size > 1) return fallback;
    const [errorType] = types;
    // OpenAI-compatible envelopes may omit an AWS class. A 403 plus the exact
    // AWS denial phrase can still identify one of the fixed inference actions.
    const deniedAction = errorType === "AccessDenied" || errorType === "AccessDeniedException" ||
      (!errorType && response.statusCode === 403)
      ? deniedInferenceAction(error.message ?? error.Message) : undefined;
    return { ...(errorType ? { errorType } : {}), ...(deniedAction ? { deniedAction } : {}) };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function failure(status: number, source: "broker" | "upstream" = "broker", diagnostic: UpstreamDiagnostic = {}): Response {
  return Response.json({ message: status === 403 ? "Forbidden" : "Upstream request failed", source, ...diagnostic }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** Keeps credentials private; only explicitly permitted inference requests can be signed. */
export async function startCredentialBroker(
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; region: string },
  options: { upstream?: string; stsUpstream?: string; mantleUpstream?: string } = {},
): Promise<{ port: number; account: string; arn: string; stop(): void }> {
  const held = validateCredentials(credentials);
  const upstream = upstreamUrl(options.upstream, "bedrock-runtime", held.region);
  const sts = upstreamUrl(options.stsUpstream, "sts", held.region);
  const mantle = upstreamUrl(options.mantleUpstream, "bedrock-mantle", held.region);
  let identity: { account: string; arn: string };
  try {
    identity = await callerIdentity(held, sts);
  } catch {
    // AWS signature error responses can include canonical requests and session tokens.
    throw new Error("Credential identity verification failed");
  }
  const lifetime = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: 0,
    error: () => failure(502),
    async fetch(request) {
      let destination: URL;
      let query: string;
      let isMantle = false;
      try {
        const incoming = new URL(request.url);
        isMantle = incoming.pathname === "/openai/v1/responses";
        const path = incoming.pathname.replace(/^\/bedrock(?=\/)/, "");
        if (request.method !== "POST") return failure(403);
        if (!isMantle) {
          const route = path.match(/^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|converse|converse-stream)$/);
          if (!route || !Object.hasOwn(ALLOWED_MODELS, decodeURIComponent(route[1]))) return failure(403);
        }
        query = canonicalQuery(incoming.search);
        destination = new URL(isMantle ? mantle : upstream);
        destination.pathname = path;
        destination.search = incoming.search;
      } catch {
        return failure(403);
      }
      try {
        const body = Buffer.from(await request.arrayBuffer());
        if (isMantle) {
          try {
            const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
            if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
                (payload as Record<string, unknown>).model !== CI_BEDROCK_MODELS.codex) {
              return failure(403);
            }
          } catch {
            return failure(403);
          }
        }
        const headers = forwardHeaders(request.headers);
        signRequest(destination, query, body, headers, held, isMantle ? "bedrock-mantle" : "bedrock");
        const response = await sendRequest(destination, body, headers,
          AbortSignal.any([request.signal, lifetime.signal]));
        const status = response.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          const diagnostic = await upstreamDiagnostic(response);
          response.destroy();
          return failure(status >= 400 && status <= 599 ? status : 502, "upstream", diagnostic);
        }
        const upstreamHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          upstreamHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        }
        const responseHeaders = forwardHeaders(upstreamHeaders);
        responseHeaders.set("cache-control", "no-store");
        if (status === 204 || status === 205) {
          response.destroy();
          return new Response(null, { status, headers: responseHeaders });
        }
        // No text/JSON decoding or buffering: AWS event-stream frames stay byte-identical.
        return new Response(Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, {
          status, headers: responseHeaders,
        });
      } catch {
        return failure(502);
      }
    },
  });
  return {
    port: server.port!,
    ...identity,
    stop() {
      lifetime.abort();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  try {
    // The CLI has no options: particularly no credential or upstream argv/env inputs.
    if (process.argv.length !== 2) throw new Error("Unexpected arguments");
    const broker = await startCredentialBroker(JSON.parse(await Bun.stdin.text()));
    const stop = () => broker.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(JSON.stringify({ port: broker.port, account: broker.account, arn: broker.arn }));
  } catch {
    console.error("Credential broker startup failed");
    process.exitCode = 1;
  }
}
