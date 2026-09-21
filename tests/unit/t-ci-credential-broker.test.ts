// covers: file:scripts/ci-credential-broker.ts
// Loopback fixtures only. The independent signature verifier uses WebCrypto and
// explicit canonical path/query expectations, not broker signing helpers.
import { afterEach, describe, expect, test } from "bun:test";
import { CI_BEDROCK_MODELS, startCredentialBroker } from "../../scripts/ci-credential-broker.ts";

const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "fixture-session-token+/=",
  region: "us-east-1",
};
const account = "123456789012";
const arn = `arn:aws:sts::${account}:assumed-role/ci-nightly/session-1`;
const identityXml = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${arn}</Arn><UserId>FIXTURE:session-1</UserId><Account>${account}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`;
const encoder = new TextEncoder();
const stop: Array<() => void> = [];

afterEach(() => {
  for (const dispose of stop.splice(0).reverse()) dispose();
});

interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
}

function collector(reply: (request: CapturedRequest) => Response = () => new Response("ok")) {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const captured = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      };
      requests.push(captured);
      return reply(captured);
    },
  });
  stop.push(() => server.stop(true));
  return { requests, origin: `http://127.0.0.1:${server.port}` };
}

async function fixture(reply?: (request: CapturedRequest) => Response, mantleReply?: (request: CapturedRequest) => Response) {
  const upstream = collector(reply);
  const mantle = collector(mantleReply);
  const sts = collector(() => new Response(identityXml, { headers: { "content-type": "text/xml" } }));
  const broker = await startCredentialBroker(credentials, {
    upstream: upstream.origin, stsUpstream: sts.origin, mantleUpstream: mantle.origin,
  });
  stop.push(broker.stop);
  return { broker, upstream, mantle, sts, origin: `http://127.0.0.1:${broker.port}` };
}

async function verifySignature(
  captured: CapturedRequest,
  service: "sts" | "bedrock" | "bedrock-mantle",
  canonicalPath: string,
  canonicalQuery: string,
): Promise<void> {
  const { headers, method, body, url } = captured;
  const timestamp = headers.get("x-amz-date")!;
  expect(timestamp).toMatch(/^\d{8}T\d{6}Z$/);
  expect(headers.get("host")).toBe(url.host);
  expect(headers.get("x-amz-security-token")).toBe(credentials.sessionToken);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
  expect(headers.get("x-amz-content-sha256")).toBe(digest);
  const names = ["content-type", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token"];
  const canonicalHeaders = names.map(name => `${name}:${headers.get(name)!.trim().replace(/\s+/g, " ")}\n`).join("");
  const canonical = `${method}\n${canonicalPath}\n${canonicalQuery}\n${canonicalHeaders}\n${names.join(";")}\n${digest}`;
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(canonical))).toString("hex");
  const scope = `${timestamp.slice(0, 8)}/${credentials.region}/${service}/aws4_request`;
  let signingKey: Uint8Array<ArrayBuffer> = encoder.encode(`AWS4${credentials.secretAccessKey}`);
  for (const data of [timestamp.slice(0, 8), credentials.region, service, "aws4_request"]) {
    const key = await crypto.subtle.importKey("raw", signingKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    signingKey = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  }
  const key = await crypto.subtle.importKey("raw", signingKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key,
    encoder.encode(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash}`))).toString("hex");
  expect(headers.get("authorization")).toBe(
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  );
}

async function readBytes(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < count) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    chunks.push(chunk.value!);
    received += chunk.value!.length;
  }
  return Buffer.concat(chunks);
}

describe("CI request-signing broker", () => {
  test("verifies identity with STS before returning and exposes no credentials endpoint", async () => {
    const { broker, sts, origin, upstream } = await fixture();
    expect({ account: broker.account, arn: broker.arn }).toEqual({ account, arn });
    const [identityRequest] = sts.requests;
    expect(sts.requests).toHaveLength(1);
    expect(identityRequest.method).toBe("POST");
    expect(identityRequest.url.pathname + identityRequest.url.search).toBe("/");
    expect(new TextDecoder().decode(identityRequest.body)).toBe("Action=GetCallerIdentity&Version=2011-06-15");
    await verifySignature(identityRequest, "sts", "/", "");
    for (const headers of [new Headers(), new Headers({ "X-AIDLC-Broker-Token": "obsolete-token" })]) {
      const response = await fetch(`${origin}/credentials`, { headers });
      expect(response.status).toBe(403);
      const body = await response.text();
      for (const secret of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken]) {
        expect(body).not.toContain(secret);
      }
    }
    expect(upstream.requests).toHaveLength(0);
    expect(Object.keys(broker).sort()).toEqual(["account", "arn", "port", "stop"]);
  });

  test("signs exact binary payload and escaped path/query while replacing client credentials", async () => {
    const result = new Uint8Array([0, 255, 128, 13, 10, 42]);
    const { origin, upstream } = await fixture(() => new Response(result, {
      headers: { "content-type": "application/octet-stream", "x-amzn-requestid": "request-1" },
    }));
    const path = "/model/global.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke";
    const query = "?z=last&empty&same=b&same=a&space=a%20b&plus=a+b&escaped=%2F%25&bang=%21%27%28%29%2A&utf8=%E9%9B%AA&eq=a=b&%C3%A9=accent&Z=upper";
    const canonicalQuery = "%C3%A9=accent&Z=upper&bang=%21%27%28%29%2A&empty=&eq=a%3Db&escaped=%2F%25&plus=a%2Bb&same=a&same=b&space=a%20b&utf8=%E9%9B%AA&z=last";
    const body = encoder.encode('{"prompt":"雪","raw":"\\u0000","max_tokens":3}\n');
    const response = await fetch(`${origin}/bedrock${path}${query}`, {
      method: "POST", body,
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer client-secret",
        "X-Amz-Date": "20000101T000000Z",
        "X-Amz-Security-Token": "client-session-secret",
        "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
        "X-Amz-Custom": "must-not-pass",
        "X-AIDLC-Broker-Token": "must-not-pass",
        "X-Api-Key": "client-api-secret",
        Cookie: "session=client-cookie",
        "X-Amzn-Bedrock-Accept": "application/json",
      },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(result);
    expect(response.headers.get("x-amzn-requestid")).toBe("request-1");
    const [captured] = upstream.requests;
    expect(captured.method).toBe("POST");
    expect(captured.url.pathname + captured.url.search).toBe(path + query);
    expect(captured.body).toEqual(body);
    expect(captured.headers.get("x-amzn-bedrock-accept")).toBe("application/json");
    for (const name of ["x-amz-custom", "x-aidlc-broker-token", "x-api-key", "cookie"]) {
      expect(captured.headers.has(name)).toBe(false);
    }
    await verifySignature(captured, "bedrock", "/model/global.anthropic.claude-haiku-4-5-20251001-v1%253A0/invoke", canonicalQuery);
  });

  test("permits only the shared CI model pins and inference operations", async () => {
    const { origin, upstream } = await fixture();
    const models = [...Object.values(CI_BEDROCK_MODELS.claude).map(model => model.replace(/\[1m\]$/, "")),
      CI_BEDROCK_MODELS.codex, CI_BEDROCK_MODELS.opencode];
    for (const model of models) {
      const response = await fetch(`${origin}/model/${encodeURIComponent(model)}/converse`, {
        method: "POST", body: "{}", headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    }
    const sent = upstream.requests.length;
    const allowed = `/model/${CI_BEDROCK_MODELS.codex}/invoke`;
    for (const [method, path] of [
      ["GET", allowed],
      ["PUT", allowed],
      ["POST", "/"],
      ["POST", "/credentials"],
      ["POST", "/bedrock/model/unknown-model/invoke"],
      ["POST", "/model/__proto__/invoke"],
      ["POST", "/model/openai.gpt-5.5/delete"],
      ["POST", "/model/openai.gpt-5.5/invoke/extra"],
      ["POST", "/model/openai.gpt-5.5%2Fother/invoke"],
      ["POST", "/model/openai.gpt-5.5%252Fother/invoke"],
      ["POST", "/model/global.anthropic.claude-opus-4-8%5B1m%5D/invoke"],
      ["POST", "/model/%E0%A4%A/invoke"],
      ["POST", `${allowed}?%58-Amz-Credential=client-secret`],
      ["POST", `${allowed}?x-amz-signature=client-signature`],
      ["POST", `${allowed}?authorization=Bearer%20secret`],
      ["POST", `${allowed}?malformed=%FF`],
    ]) {
      const response = await fetch(origin + path, { method });
      expect(response.status).toBe(403);
      await response.body?.cancel();
    }
    expect(upstream.requests).toHaveLength(sent);
  });

  test.each(["invoke-with-response-stream", "converse-stream"])("streams %s bytes before completion", async (operation) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const first = new Uint8Array([0, 0, 0, 17, 255, 128, 13, 10]);
    const second = new Uint8Array([0, 42, 255, 1, 2, 3, 4, 5]);
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(first); },
    });
    const { origin } = await fixture(() => new Response(stream, {
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    }));
    const timeout = AbortSignal.timeout(3_000);
    const response = await fetch(`${origin}/bedrock/model/${CI_BEDROCK_MODELS.opencode}/${operation}`, {
      method: "POST", body: "{}", signal: timeout,
    });
    expect(response.headers.get("content-type")).toBe("application/vnd.amazon.eventstream");
    const reader = response.body!.getReader();
    try {
      // The producer has not emitted the second chunk or closed. A buffering
      // proxy cannot satisfy either read and the request deadline fails the test.
      expect(await readBytes(reader, first.length)).toEqual(Buffer.from(first));
      controller.enqueue(second);
      expect(await readBytes(reader, second.length)).toEqual(Buffer.from(second));
      controller.close();
      expect((await reader.read()).done).toBe(true);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  test("signs Codex Responses requests to Mantle without rewriting their JSON payload", async () => {
    const { origin, mantle, upstream } = await fixture(undefined,
      () => Response.json({ id: "response-fixture", output: [] }));
    const body = encoder.encode(`{ "input": "snow 雪", "model": "${CI_BEDROCK_MODELS.codex}", "store": false }\n`);
    const response = await fetch(`${origin}/openai/v1/responses`, {
      method: "POST", body,
      headers: {
        "content-type": "application/json",
        Authorization: "AWS4-HMAC-SHA256 Credential=placeholder/wrong-scope",
        "X-Amz-Security-Token": "client-token",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "response-fixture", output: [] });
    expect(upstream.requests).toHaveLength(0);
    expect(mantle.requests).toHaveLength(1);
    const [captured] = mantle.requests;
    expect(captured.url.pathname).toBe("/openai/v1/responses");
    expect(captured.body).toEqual(body);
    await verifySignature(captured, "bedrock-mantle", "/openai/v1/responses", "");
  });

  test("refuses non-Codex models and non-Responses Mantle operations", async () => {
    const { origin, mantle, upstream } = await fixture();
    for (const body of [
      "{}", "null", "[]", "malformed-json",
      JSON.stringify({ model: null }),
      JSON.stringify({ model: [CI_BEDROCK_MODELS.codex] }),
      JSON.stringify({ model: CI_BEDROCK_MODELS.opencode }),
      JSON.stringify({ model: `${CI_BEDROCK_MODELS.codex}[1m]` }),
      JSON.stringify({ model: "openai.gpt-5.6", input: "unauthorized model" }),
    ]) {
      const response = await fetch(`${origin}/openai/v1/responses`, {
        method: "POST", body, headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(403);
      await response.body?.cancel();
    }
    for (const [method, path] of [
      ["GET", "/openai/v1/responses"],
      ["DELETE", "/openai/v1/responses"],
      ["POST", "/openai/v1/responses/response-id/cancel"],
      ["POST", "/openai/v1/responses/"],
      ["POST", "/openai/v1/chat/completions"],
      ["POST", "/v1/responses"],
      ["POST", "/bedrock/openai/v1/responses"],
      ["POST", "/openai/v1/responses?X-Amz-Signature=client-signature"],
    ]) {
      const response = await fetch(origin + path, {
        method, ...(method === "GET" ? {} : { body: JSON.stringify({ model: CI_BEDROCK_MODELS.codex }) }),
      });
      expect(response.status).toBe(403);
      await response.body?.cancel();
    }
    expect(mantle.requests).toHaveLength(0);
    expect(upstream.requests).toHaveLength(0);
  });

  test("streams Mantle SSE events before the response completes", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const first = encoder.encode('event: response.created\ndata: {"type":"response.created"}\n\n');
    const second = encoder.encode('event: response.output_text.delta\ndata: {"delta":"雪"}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(first); },
    });
    const { origin } = await fixture(undefined, () => new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await fetch(`${origin}/openai/v1/responses`, {
      method: "POST", signal: AbortSignal.timeout(3_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: CI_BEDROCK_MODELS.codex, input: "hello", stream: true, store: false }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    try {
      expect(await readBytes(reader, first.length)).toEqual(Buffer.from(first));
      controller.enqueue(second);
      expect(await readBytes(reader, second.length)).toEqual(Buffer.from(second));
      controller.close();
      expect((await reader.read()).done).toBe(true);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  test("does not decompress successful responses", async () => {
    const compressed = Bun.gzipSync(encoder.encode("binary response must remain compressed"));
    const { origin } = await fixture(() => new Response(compressed, {
      headers: { "content-type": "application/octet-stream", "content-encoding": "gzip" },
    }));
    const response = await fetch(`${origin}/model/${CI_BEDROCK_MODELS.codex}/invoke`, {
      method: "POST", body: "{}", decompress: false,
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(compressed);
  });

  test("never follows redirects and conceals signature errors that echo credentials", async () => {
    const destination = collector();
    let redirect = true;
    const echoedSecrets = Object.values(credentials).join(" ");
    const { origin } = await fixture(() => new Response(echoedSecrets, {
      status: redirect ? 307 : 403,
      headers: { location: `${destination.origin}/steal`, "x-amz-security-token": credentials.sessionToken },
    }));
    const request = { method: "POST", body: "{}" };
    const first = await fetch(`${origin}/model/${CI_BEDROCK_MODELS.codex}/invoke`, request);
    expect(first.status).toBe(502);
    expect(first.headers.has("location")).toBe(false);
    expect(await first.text()).not.toContain(credentials.sessionToken);
    expect(destination.requests).toHaveLength(0);
    redirect = false;
    const error = await fetch(`${origin}/model/${CI_BEDROCK_MODELS.codex}/invoke`, request);
    expect(error.status).toBe(403);
    const body = await error.text();
    for (const secret of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken]) {
      expect(body).not.toContain(secret);
    }
    expect(error.headers.has("x-amz-security-token")).toBe(false);
  });

  test("fails closed on failed or malformed STS identity without exposing its response", async () => {
    for (const [status, body] of [
      [403, credentials.sessionToken],
      [200, `<Error>${credentials.secretAccessKey}</Error>`],
      [200, identityXml.replace(account, "999999999999")],
    ] as const) {
      const sts = collector(() => new Response(body, { status }));
      await expect(startCredentialBroker(credentials, { stsUpstream: sts.origin }))
        .rejects.toThrow("Credential identity verification failed");
    }
  });

  test("validates credentials and confines all fixture overrides to literal loopback origins", async () => {
    const sts = collector(() => new Response(identityXml));
    for (const input of [
      null, [], {}, { ...credentials, sessionToken: "" },
      { ...credentials, secretAccessKey: 123 },
      { ...credentials, accessKeyId: "INJECT/20260101" },
      { ...credentials, sessionToken: "secret\r\nx-inject: yes" },
      { ...credentials, region: "us-east-1.evil.invalid/path" },
    ]) {
      await expect(startCredentialBroker(input as typeof credentials, { stsUpstream: sts.origin }))
        .rejects.toThrow("Invalid broker credentials");
    }
    for (const override of [
      "https://example.com", "http://localhost:1234", "http://127.0.0.1.evil.invalid", "file:///etc/passwd",
      "http://user:password@127.0.0.1:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:1234?host=evil",
    ]) {
      await expect(startCredentialBroker(credentials, { upstream: override, stsUpstream: sts.origin }))
        .rejects.toThrow("Invalid loopback upstream");
      await expect(startCredentialBroker(credentials, { stsUpstream: override }))
        .rejects.toThrow("Invalid loopback upstream");
      await expect(startCredentialBroker(credentials, { mantleUpstream: override, stsUpstream: sts.origin }))
        .rejects.toThrow("Invalid loopback upstream");
    }
    expect(sts.requests).toHaveLength(0);
  });

  test("CLI rejects malformed stdin and all argv overrides without printing secrets", async () => {
    const script = new URL("../../scripts/ci-credential-broker.ts", import.meta.url).pathname;
    for (const [args, stdin] of [
      [[], `{"accessKeyId":"${credentials.accessKeyId}","secretAccessKey":"${credentials.secretAccessKey}",`],
      [[], JSON.stringify({ ...credentials, region: "not-a-region" })],
      [["--upstream", "http://127.0.0.1:1"], JSON.stringify(credentials)],
    ] as const) {
      const child = Bun.spawn([process.execPath, script, ...args], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "" },
      });
      stop.push(() => child.kill());
      child.stdin.write(stdin);
      child.stdin.end();
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(1);
      expect(stdout).toBe("");
      for (const secret of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken]) {
        expect(stderr).not.toContain(secret);
      }
    }
  });
});
