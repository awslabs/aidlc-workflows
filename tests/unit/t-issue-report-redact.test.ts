// redact() and gate(): the two functions every shared byte goes through.
// Each secret below is made up. A case passes only when redact() removes the
// value AND gate() flags the unredacted text, so a gap in either fails.

import { describe, expect, test } from "bun:test";
import { importSecretRules } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";
import { type Dictionary, redact, redactValue, useSecretRules } from "../../core/skills/aidlc-issue-report/scripts/redact.ts";
import { textHits } from "../../core/skills/aidlc-issue-report/scripts/lib-gate.ts";

// Secrets are AI-DLC's own rules, as the skill loads them from an install.
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path
useSecretRules(await importSecretRules(RULES));

// What the check (lib-gate.ts) refuses in a line of the report, with no AI-DLC words known.
const gate = (text: string, dict: Dictionary) => textHits({ words: new Set(), dict, allowed: [] }, text);

const empty: Dictionary = { entries: [] };
// Made-up secret values, built from pieces so the source holds no secret-shaped literal.
const V12 = ["abcd", "1234", "efgh"].join("");
const V16 = [V12, "5678"].join("");

describe("secret shapes", () => {
  const cases: Array<[string, string, string]> = [
    ["bare assignment", "password=hunter22x", "hunter22x"],
    ["env var with a prefix", `AWS_SECRET_ACCESS_KEY=${V16}`, V16],
    ["token env var", "GITHUB_TOKEN=abcdefgh1234", "abcdefgh1234"],
    ["password env var", "DB_PASSWORD=hunter22x", "hunter22x"],
    ["JSON key", '{"password": "hunter22x"}', "hunter22x"],
    ["escaped JSON key", '{\\"api_key\\":\\"abcd1234efgh\\"}', "abcd1234efgh"],
    ["YAML key", `client_secret: ${V12}`, V12],
    ["Bearer header", "Authorization: Bearer abc.def.ghi123456", "abc.def.ghi123456"],
    ["Google API key", `key ${["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join("")}`, ["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join("")],
    ["GitLab token", ["glpat", "-abcdefghij1234567890"].join(""), ["glpat", "-abcdefghij1234567890"].join("")],
    ["Stripe key", ["sk_", "live_abcdefghij1234"].join(""), ["sk_", "live_abcdefghij1234"].join("")],
    ["AWS access key id", ["AKIA", "ABCDEFGHIJKLMNOP"].join(""), ["AKIA", "ABCDEFGHIJKLMNOP"].join("")],
  ];
  for (const [name, text, secret] of cases) {
    test(name, () => {
      expect(redact(text, empty)).not.toContain(secret);
      expect(gate(text, empty).length).toBeGreaterThan(0);
    });
  }

  test("a secret redacted to its label passes the check", () => {
    for (const [name, text] of cases) if (name !== "escaped JSON key") expect(gate(redact(text, empty), empty)).toEqual([]);
  });

  test("a Basic credential is refused by the check, a word after Basic is not", () => {
    expect(gate("Authorization: Basic dXNlcjpwYXNzd29yZDEy", empty).length).toBeGreaterThan(0);
    expect(gate("Basic Onboarding and Basic Options", empty)).toEqual([]);
  });

  test("a JSON value redacted value by value stays JSON", () => {
    const out = JSON.stringify(redactValue({ note: "set password=hunter22x", nested: { cmd: `export API_KEY=${V12}` } }, empty));
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain("hunter22x");
    expect(out).not.toContain("abcd1234efgh");
  });

  test("ordinary words around secret names stay", () => {
    for (const text of ["the token budget ran out", "secret-sharing is off", "password reset page"]) {
      expect(redact(text, empty)).toBe(text);
      expect(gate(text, empty)).toEqual([]);
    }
  });
});

describe("home-folder paths outside the project", () => {
  const dict: Dictionary = { entries: [{ value: "/Users/jdoe/work/shop", label: "<project>", kind: "path" }, { value: "/Users/jdoe", label: "~", kind: "path" }] };
  test("another project's path is replaced and flagged", () => {
    for (const text of [
      "stale registrations: /Users/jdoe/Downloads/acme-kit, /Users/jdoe/clients/contoso/app",
      "stale registrations: ~/Downloads/acme-kit",
      "C:\\Users\\jdoe\\clients\\contoso",
    ]) {
      const out = redact(text, dict);
      expect(out).not.toContain("acme-kit");
      expect(out).not.toContain("contoso");
      expect(gate(text, dict).length).toBeGreaterThan(0);
      expect(gate(out, dict)).toEqual([]);
    }
  });
  test("the project, AI-DLC's and the tools' own folders stay readable", () => {
    for (const text of [
      "~/.claude/projects is read",
      "~/.kiro/settings/cli.json",
      "~/.local/share/aidlc/versions",
      "~/.codex/sessions",
    ]) {
      expect(gate(redact(text, dict), dict)).toEqual([]);
    }
    expect(redact("~/.kiro/settings/cli.json", dict)).toBe("~/.kiro/settings/cli.json");
  });
});

describe("paths as JSON writes them, and folders next to the project", () => {
  const dict: Dictionary = {
    entries: [
      { value: "C:\\Users\\jdoe\\work\\shop", label: "<project>", kind: "path" },
      { value: "/Users/jdoe/work/shop", label: "<project>", kind: "path" },
      { value: "C:\\Users\\jdoe", label: "~", kind: "path" },
      { value: "/Users/jdoe", label: "~", kind: "path" },
    ],
  };
  test("a Windows path inside JSON text is replaced and flagged", () => {
    for (const value of ["C:\\Users\\jdoe\\clients\\contoso", "C:\\Users\\jdoe\\work\\shop\\src", "C:\\Users\\li\\clients\\contoso"]) {
      const json = JSON.stringify({ p: value });
      const out = redact(json, dict);
      expect(out).not.toContain("contoso");
      expect(out).not.toContain("jdoe");
      expect(() => JSON.parse(out)).not.toThrow();
      expect(gate(value, dict).length).toBeGreaterThan(0);
      if (!value.includes("shop")) expect(gate(JSON.parse(out).p, dict)).toEqual([]);
    }
  });
  test("a folder whose name starts with the project's keeps no tail", () => {
    const out = redact("/Users/jdoe/work/shop-acme/x", dict);
    expect(out).not.toContain("acme");
    // A file under the project is the person's too: the check refuses its name.
    expect(gate(out, dict).length).toBeGreaterThan(0);
    expect(redact("/Users/jdoe/work/shop/src/a.ts", dict)).toBe("<project>/src/a.ts");
  });
});

test("long ids are replaced, the install's source tag is kept", () => {
  const out = JSON.stringify(redactValue({ native: { sourceRef: "refs/tags/v2.11.2" }, session: "137307be-2b29-4ff6-91c0-0948e739ddcd" }, empty, { ids: true }));
  expect(out).toContain("refs/tags/v2.11.2");
  expect(out).not.toContain("137307be");
});

describe("secrets over lines, names in identifiers, labels and tool folders", () => {
  test("a secret split over lines is flagged", () => {
    // Built from pieces: a made-up body in a private key's shape, no key in the source.
    const fence = (end: string) => `-----${end} RSA ${["PRIVATE", "KEY"].join(" ")}-----`;
    const pem = [fence("BEGIN"), ...Array.from({ length: 4 }, (_, i) => `Xy${i}zQ`.repeat(13)), fence("END")].join("\n");
    const report = `The tool printed:\n${pem}\nand stopped.`;
    expect(gate(report, empty).some((l) => /secret|private key/.test(l.reason))).toBe(true);
    const nextLine = "password:\n  hunter22x";
    expect(gate(nextLine, empty).length + gate("password: hunter22x", empty).length).toBeGreaterThan(0);
  });

  test("a name the person hid is caught inside a file or class name", () => {
    const dict: Dictionary = { entries: [{ value: "Contoso", label: "<customer-1>", kind: "named" }] };
    for (const text of ["ContosoClient.ts failed", "the contoso2026 build", "src/contosoPortal/app.ts"]) {
      expect(redact(text, dict)).not.toMatch(/contoso/i);
      expect(gate(text, dict).length).toBeGreaterThan(0);
    }
  });

  test("a name that is also a label word does not break the labels", () => {
    const dict: Dictionary = {
      entries: [
        { value: "email", label: "<unit-1>", kind: "unit" },
        { value: "account", label: "<unit-2>", kind: "unit" },
      ],
    };
    const out = redact("kim@acme.example paid from 123456789012 in the email unit", dict);
    expect(out).toBe("<email> paid from <account> in the <unit-1> unit");
    expect(gate("The address was <email>, paid from <account>.", dict)).toEqual([]);
  });

  test("a public AI-DLC address keeps its path, loses its query, and a look-alike host is not public", () => {
    expect(redact("see https://kiro.dev/docs/hooks?tenant=PrivateTenant#x", empty)).toBe("see https://kiro.dev/docs/hooks");
    expect(redact("https://kiro.dev.acme-corp.example/x", empty)).toBe("<url>");
    expect(redact("https://github.com/awslabs/aidlc-workflows-acme/pull/1", empty)).toBe("<url>");
    expect(redact("https://github.com/awslabs/aidlc-workflows/pull/1", empty)).toBe("https://github.com/awslabs/aidlc-workflows/pull/1");
    expect(gate("https://kiro.dev.acme-corp.example/x", empty).length).toBeGreaterThan(0);
  });

  test("under a tool's chat-log folders, where folder names encode the person's paths, only the folder stays", () => {
    const dict: Dictionary = { entries: [{ value: "/Users/jdoe", label: "~", kind: "path" }] };
    expect(redact("/Users/jdoe/.claude/projects/-Users-jdoe-clients-acme/s.jsonl", dict)).toBe("~/.claude/projects/<path>");
    expect(redact("~/.codex/sessions/2026/10/29/rollout-acme.jsonl", dict)).toBe("~/.codex/sessions/<path>");
    expect(redact("~/.kiro/settings/cli.json", dict)).toBe("~/.kiro/settings/cli.json");
    expect(gate(redact("~/.claude/projects/-Users-x-clients-acme", dict), dict)).toEqual([]);
    expect(gate("~/.claude/projects/-Users-x-clients-acme", dict).length).toBeGreaterThan(0);
  });
});

describe("names in brackets, decomposed names, URL schemes, paths with spaces", () => {
  const hidden: Dictionary = {
    entries: [
      { value: "Contoso", label: "<customer-1>", kind: "named" },
      { value: "SAP", label: "<product-1>", kind: "named" },
      { value: "jdoe", label: "<user>", kind: "os-user" },
      { value: "/Users/jdoe", label: "~", kind: "path" },
    ],
  };
  test("a name inside angle brackets that are not one of the labels is still found", () => {
    for (const text of ["type Promise<ContosoOrder> failed", "List<Contoso>", "owner <jdoe>", "Map<string, SAPClient>"]) {
      expect(redact(text, hidden)).not.toMatch(/contoso|jdoe|sap/i);
      expect(gate(text, hidden).length).toBeGreaterThan(0);
    }
  });
  test("a folder name stored decomposed (macOS) matches the same name typed", () => {
    const dict: Dictionary = { entries: [{ value: "쇼핑몰".normalize("NFD"), label: "<project>", kind: "project-name" }] };
    expect(redact("쇼핑몰 빌드", dict)).toBe("<project> 빌드");
    expect(gate("쇼핑몰 빌드", dict).length).toBeGreaterThan(0);
  });
  test("any URL scheme is a URL, and a public host cannot carry another in its authority", () => {
    expect(redact("s3://contoso-data/exports", empty)).toBe("<url>");
    expect(redact("https://kiro.dev:443@contoso/docs", empty)).toBe("<url>");
  });
  test("a path with a space and an agent file under a tool's folder are the person's", () => {
    expect(redact("~/My Clients/Contoso/app", empty)).toBe("~/<path>");
    expect(redact("~/.kiro/agents/contoso-agent.json", empty)).toBe("~/.kiro/<path>");
    expect(redact("~/Library/Application Support/Kiro/User", empty)).toBe("~/Library/Application Support/Kiro/User");
  });
});

describe("short names, secrets holding values, home paths read to their end", () => {
  const named = (value: string, label = "<person-1>"): Dictionary => ({ entries: [{ value, label, kind: "named" }] });
  test("a short hidden name is found at a word or case boundary, not inside an ordinary word", () => {
    const d = named("Dan");
    expect(redact("guidance for redundant runs", d)).toBe("guidance for redundant runs");
    expect(gate("guidance for redundant runs", d)).toEqual([]);
    expect(redact("Dan approved; DanCorp and dan2026 too", d)).toBe("<person-1> approved; <person-1>Corp and <person-1>2026 too");
  });
  test("a secret's value is masked whole before an IP or email inside it", () => {
    expect(redact(["pass", "word=192.168.0.1-PrivateTail"].join(""), empty)).not.toContain("PrivateTail");
    expect(redact("see https://alice@auth.example/PrivateTenant", empty)).toBe("see <url>");
  });
  test("a home path is read to its end: in quotes, and through a file name with a space", () => {
    expect(redact('opened "~/Clients/Contoso Merger.pdf"', empty)).toBe('opened "~/<path>"');
    expect(redact("opened ~/Clients/Contoso Merger.pdf", empty)).toBe("opened ~/<path>");
  });
  test("a folder named like the project but longer is the project's label whole", () => {
    const d: Dictionary = { entries: [{ value: "/srv/shop", label: "<project>", kind: "path" }] };
    expect(redact("/srv/shop.Contoso/x", d)).toBe("<project>/x");
  });
  test("only this skill's own label shapes are protected", () => {
    expect(gate("the <custom-contoso-1> stage", named("Contoso")).length).toBeGreaterThan(0);
    expect(gate("the <custom-stage-1> stage", named("Contoso"))).toEqual([]);
  });
  test("a hit says where, never any part of the value", () => {
    const hits = JSON.stringify(gate("mail kim@acme.example", empty));
    expect(hits).not.toContain("kim");
    expect(hits).not.toContain("acme");
  });
});

describe("names with spaces, other homes in quotes, where a known path stops", () => {
  test("a hidden name with a space at a home path's end is replaced whole", () => {
    const d: Dictionary = { entries: [{ value: "Contoso Merger", label: "<customer-1>", kind: "named" }] };
    const out = redact("opened ~/Clients/Contoso Merger and stopped", d);
    expect(out).not.toContain("Contoso");
    expect(out).not.toContain("Merger");
    expect(out).toContain(" and stopped");
    expect(gate(out, d)).toEqual([]);
  });
  test("another person's home folder in quotes is replaced whole, a space in their name included", () => {
    const out = redact('read "/Users/Jane Doe/Clients/Contoso"', empty);
    expect(out).toBe('read "/Users/<user>/<path>"');
    expect(gate('read "/Users/Jane Doe/Clients/Contoso"', empty).length).toBeGreaterThan(0);
    expect(gate(out, empty)).toEqual([]);
    expect(redact("read /Users/Jane Doe/Clients/Contoso", empty)).toBe("read /Users/<user>/<path>");
  });
  test("a known path stops at a space, a backtick or a sentence's last dot", () => {
    const d: Dictionary = { entries: [{ value: "/srv/shop", label: "<project>", kind: "path" }] };
    expect(redact("cd /srv/shop and run", d)).toBe("cd <project> and run");
    expect(redact("opened `/srv/shop` and stopped", d)).toBe("opened `<project>` and stopped");
    expect(redact("opened /srv/shop. Then stopped", d)).toBe("opened <project>. Then stopped");
  });
});

describe("names beside and inside known paths, data keys", () => {
  test("a hidden name right after a known path is replaced whole, not cut by the path", () => {
    const d: Dictionary = {
      entries: [
        { value: "Contoso SAP", label: "<customer-1>", kind: "named" },
        { value: "/srv/shop", label: "<project>", kind: "path" },
      ],
    };
    const out = redact("read /srv/shop Contoso SAP/x", d);
    expect(out).toBe("read <project> <customer-1>/x");
  });
  test("a known path that holds a hidden name is still the path's label", () => {
    const d: Dictionary = {
      entries: [
        { value: "/srv/contoso-shop", label: "<project>", kind: "path" },
        { value: "Contoso", label: "<customer-1>", kind: "named" },
      ],
    };
    expect(redact("opened /srv/contoso-shop/src/a.ts", d)).toBe("opened <project>/src/a.ts");
  });
  test("a key that is not one of safe.json's own field names is data", () => {
    const d: Dictionary = { entries: [{ value: "contoso", label: "<customer-1>", kind: "named" }] };
    expect(redactValue({ contoso: 1, status: "complete" }, d)).toEqual({ "<customer-1>": 1, status: "complete" });
  });
});

describe("hidden names inside URLs, emails, secrets and home paths", () => {
  const named = (value: string, label = "<customer-1>"): Dictionary => ({ entries: [{ value, label, kind: "named" }] });
  test("a URL, an email or a bucket whose host holds a hidden name is replaced whole, and flagged when a label stands there", () => {
    const d = named("Contoso");
    expect(redact("see https://Contoso.example/PrivateTenant now", d)).toBe("see <url> now");
    expect(redact("mail bob.smith@contoso.com", d)).toBe("mail <email>");
    for (const text of ["https://<customer-1>.sharepoint.com/sites/ProjectFalcon", "bob.smith@<customer-1>.com", "s3://<customer-1>-prod-backups/finance"]) {
      expect(gate(text, d).length).toBeGreaterThan(0);
    }
  });
  test("a secret that holds a hidden name is masked whole, and flagged when a label stands in it", () => {
    const d = named("Contoso");
    expect(redact("password=ContosoSecret123", d)).not.toContain("Secret123");
    expect(gate("password=<customer-1>Secret123", d).some((l) => l.reason === "a credential")).toBe(true);
    expect(gate("password=<redacted>", d)).toEqual([]);
  });
  test("a home path that holds a hidden name is replaced to its end", () => {
    const d = named("Contoso");
    expect(redact("opened ~/Clients/Contoso/PrivateFolder/x", d)).toBe("opened ~/<path>");
    expect(redact("opened /Users/Contoso/Private/x", d)).toBe("opened /Users/<user>/<path>");
    expect(gate("opened ~/<path><customer-1>/PrivateFolder/x", d).length).toBeGreaterThan(0);
    expect(gate("opened ~/<path> and /Users/<user>/<path>", d)).toEqual([]);
  });
  test("an unquoted home path takes a capitalized word after a space; a quoted known path is read to its quote", () => {
    expect(redact("opened ~/Clients/Contoso Merger and stopped", empty)).toBe("opened ~/<path> and stopped");
    const d: Dictionary = { entries: [{ value: "/srv/shop", label: "<project>", kind: "path" }] };
    expect(redact('opened "/srv/shop Finance Shared/x"', d)).toBe('opened "<project>/x"');
  });
  test("a hidden name that is part of another hidden name's label does not stop the project path matching", () => {
    const d: Dictionary = {
      entries: [
        { value: "/srv/AcmeCorporation-private", label: "<project>", kind: "path" },
        { value: "AcmeCorporation", label: "<customer-1>", kind: "named" },
        { value: "customer", label: "<product-1>", kind: "named" },
      ],
    };
    expect(redact("opened /srv/AcmeCorporation-private/x", d)).toBe("opened <project>/x");
  });
  test("an audit field name copied into safe.json stays a field name when a hidden name equals it", () => {
    expect(redactValue({ audit: { problems: [{ Stage: "requirements-analysis" }] } }, named("Stage"))).toEqual({ audit: { problems: [{ Stage: "requirements-analysis" }] } });
  });
});

describe("hidden names that are part of a value, paths under <user>, stand-in look-alikes", () => {
  const named = (value: string, label = "<customer-1>"): Dictionary => ({ entries: [{ value, label, kind: "named" }] });
  test("a hidden name that is part of a value's own shape does not stop the value being found", () => {
    expect(redact("password=s3cr3tValue99", named("password"))).not.toContain("s3cr3tValue99");
    expect(redact("from 192.168.1.12", named("192"))).toBe("from <ip>");
  });
  test("a path under another home written with <user> is flagged; a redacted one is left as it is", () => {
    for (const line of ["/Users/<user>/Clients/AcmeMerger/notes.txt", "C:\\Users\\<user>\\Clients\\AcmeMerger", "/home/<user>/acme-corp/app"]) {
      expect(gate(line, empty).length).toBeGreaterThan(0);
    }
    for (const line of ['"/Users/<user>/.claude/projects/<path>"', "/Users/<user>/<path>", "~/.claude/projects/<path>", '"C:\\\\Users\\\\<user>\\\\<path>"']) {
      expect(redact(line, empty)).toBe(line);
      expect(gate(line, empty)).toEqual([]);
    }
  });
  test("a home path reads through a hidden name and the capitalized words after it", () => {
    const d = named("Contoso");
    expect(redact("opened ~/Clients/Acme Contoso Finance and stopped", d)).toBe("opened ~/<path> and stopped");
  });
  test("text already shaped like a stand-in is put back as written, and never trips the check", () => {
    expect(redact("Qql0qQ <email>", empty)).toBe("Qql0qQ <email>");
    expect(redact("Qqn0qQ says hi", named("Contoso"))).toBe("Qqn0qQ says hi");
    expect(gate("~/<path>", named("Qql"))).toEqual([]);
    expect(redact("QQabcdefl0qq <email>", empty)).toBe("QQabcdefl0qq <email>");
    expect(redact("~/x QQabcdefn0qq says hi", named("Contoso"))).toBe("~/<path> says hi");
  });
});

describe("values after a label, known paths first, the check on redact() output", () => {
  const named = (value: string, label = "<customer-1>"): Dictionary => ({ entries: [{ value, label, kind: "named" }] });
  test("a value or a home path after <user> or <redacted> is still a value", () => {
    for (const [line, rest] of [
      ["password=<user>Secret123", "Secret123"],
      ["password=<redacted>Secret123", "Secret123"],
      ["https://<user>.example/PrivateTenant", "PrivateTenant"],
      ["git remote: https://<user>@bitbucket.fabrikam-corp.net/scm/x.git", "fabrikam"],
      ["bob@<user>.example", "example"],
      ["/home/<user><customer-1>/PrivateFolder", "PrivateFolder"],
      ["/Users/<redacted>/Clients/Fabrikam/x", "Fabrikam"],
    ]) {
      expect(gate(line, empty).length).toBeGreaterThan(0);
      expect(redact(line, empty)).not.toContain(rest);
    }
  });
  test("a known path is taken whole before a number or an address in it is", () => {
    const d: Dictionary = { entries: [{ value: "/srv/ClientFalcon/123456789012/shop", label: "<project>", kind: "path" }] };
    expect(redact("opened /srv/ClientFalcon/123456789012/shop/src", d)).toBe("opened <project>/src");
  });
  test("every output of redact() passes the check, whatever the hidden names", () => {
    const cases: Array<[string, Dictionary]> = [
      ["Qql0qQ and more", named("Qql")],
      ["see https://kiro.dev/docs", named("https")],
      ["opened /Users/jdoe/x and password=hunter22x", { entries: [...named("user").entries, { value: "/Users/jdoe", label: "~", kind: "path" }] }],
      ["password=hunter22x", named("redacted")],
    ];
    for (const [text, d] of cases) {
      const out = redact(text, d);
      expect(gate(out, d)).toEqual([]);
      expect(redact(out, d)).toBe(out);
    }
  });
});

describe("hidden names in plurals and longer words", () => {
  test("a hidden name in its plural, or one of five letters or more inside a longer word, is found", () => {
    const d: Dictionary = { entries: [{ value: "SAP", label: "<product-1>", kind: "named" }, { value: "Contoso", label: "<customer-1>", kind: "named" }] };
    expect(redact("the SAPs integration for the Contosoland team", d)).toBe("the <product-1> integration for the <customer-1>land team");
    expect(gate("the SAPs integration", d).length).toBeGreaterThan(0);
    expect(redact("a Danish guidance", { entries: [{ value: "Dan", label: "<person-1>", kind: "named" }] })).toBe("a Danish guidance");
  });
});

describe("generated lines (redact-property.test.ts), by kind", () => {
  const d: Dictionary = {
    entries: [
      { value: "/Users/jdoe/work/shop", label: "<project>", kind: "path" },
      { value: "/Users/jdoe", label: "~", kind: "path" },
      { value: "jdoe-mbp", label: "<host>", kind: "host" },
      { value: "jdoe", label: "<user>", kind: "os-user" },
    ],
  };
  test("a value right against a label is found by its own shape", () => {
    for (const [line, rest] of [
      ["<redacted>123456789012", "123456789012"],
      ["<url>Bearer abcdefgh12345678", "abcdefgh12345678"],
      ["<user>TOKEN=Secret1234", "Secret1234"],
      ["<host>10.20.30.40", "10.20.30.40"],
      ["bob.smith@corp.example.org<user>", "bob.smith"],
      ["<path>ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_"],
    ]) {
      expect(redact(line, empty)).not.toContain(rest);
      expect(gate(line, empty).length).toBeGreaterThan(0);
    }
  });
  test("a path after a space is a path of its own, not the end of the one before", () => {
    for (const [line, rest] of [
      ["mv ~/.claude /home/alice/PrivateFolder", "PrivateFolder"],
      ["cp ~/notes.md /Users/Bob Smith/PrivateFolder", "PrivateFolder"],
      ["~/.kiro/settings/cli.json (/home/alice/PrivateFolder)", "PrivateFolder"],
      ["~/Clients/x: /home/alice/PrivateFolder", "PrivateFolder"],
    ]) {
      expect(redact(line, d)).not.toContain(rest);
      expect(gate(line, d).length).toBeGreaterThan(0);
    }
    expect(redact("opened ~/Clients/Contoso Merger.pdf today", d)).toBe("opened ~/<path> today");
    expect(redact('"/Users/jdoe/work/shop: ~/.claude/projects/PrivateFolder/x.jsonl"', d)).not.toContain("PrivateFolder");
    expect(redact("cd ~/x [s3://tenant-bucket/k]", d)).not.toContain("tenant");
  });
  test("a quote that does not close is not read as a quoted path", () => {
    expect(redact("'/Users/jdoe/work/shop; https://kiro.dev#PrivateTicket", d)).not.toContain("PrivateTicket");
    expect(redact("`/Users/jdoe/work/shop, https://tenant.example.com/a", d)).not.toContain("tenant");
    expect(redact("'/Users/jdoe/work/shop C:\\Users\\alice\\PrivateFolder", d)).not.toContain("PrivateFolder");
    expect(redact('"/Users/jdoe/work/shop Finance Shared/x"', d)).toBe('"<project>/x"');
  });
  test("a URL ends at a backtick", () => {
    expect(redact("`s3://bucket/k`Bearer abcdefgh12345678", empty)).not.toContain("abcdefgh12345678");
    expect(redact("see `https://tenant.example.com/a`", empty)).toBe("see `<url>`");
  });
  test("what redact() wrote after a path is not read again as part of it", () => {
    for (const line of ["~/Clients/x jdoe-mbp", "~/.claude jdoe-mbp", "/home/alice/x: jdoe-mbp", "~/.kiro/settings/cli.json jdoe-mbp"]) {
      const out = redact(line, d);
      expect(gate(out, d)).toEqual([]);
      expect(redact(out, d)).toBe(out);
    }
  });
});

describe("addresses, emails and homes in less common shapes", () => {
  test("a URL right after an underscore or a digit, and one with no scheme after www., is a URL", () => {
    expect(redact("see __https://intranet.contoso.example/finance__", empty)).toBe("see __<url>");
    expect(redact("id_https://intranet.contoso.example/x", empty)).toBe("id_<url>");
    expect(redact("open www.intranet-contoso.example/finance now", empty)).toBe("open <url> now");
    for (const line of ["see __https://intranet.contoso.example/finance__", "open www.intranet-contoso.example/finance"]) {
      expect(gate(line, empty).length).toBeGreaterThan(0);
    }
  });
  test("an email whose name has letters outside ASCII is an email", () => {
    for (const line of ["mail rené@contoso.example", "mail 김기현@contoso.example"]) {
      expect(redact(line, empty)).toBe("mail <email>");
      expect(gate(line, empty).length).toBeGreaterThan(0);
    }
  });
  test("an IPv6 address is an IP; a time or a short pair of numbers is not", () => {
    expect(redact("server fe80::1ff:fe23:4567:890a and 2001:db8:85a3::8a2e:370:7334", empty)).toBe("server <ip> and <ip>");
    expect(redact("2001:0db8:85a3:0000:0000:8a2e:0370:7334", empty)).toBe("<ip>");
    for (const line of ["at 10:20:30 it stopped", "slice [1::2]", "Vec::new and std::fs"]) {
      expect(redact(line, empty)).toBe(line);
      expect(gate(line, empty)).toEqual([]);
    }
  });
  test("a Windows home under a lowercase users folder, and a name with a lowercase second word, are someone's home", () => {
    expect(redact("C:\\users\\bob\\Documents\\x.txt", empty)).toBe("C:\\users\\<user>\\<path>");
    expect(redact("/Users/jane doe/PrivateFolder/x", empty)).toBe("/Users/<user>/<path>");
    expect(redact("GET /users/42/profile", empty)).toBe("GET /users/42/profile");
  });
  // AI-DLC's own secret rules are left out of the timing: they are the install's, and take seconds on this line.
  test("a long run of dots and letters takes no more than a moment", async () => {
    useSecretRules(null);
    try {
      for (const line of ["a.".repeat(40000), `x@${"a.".repeat(40000)}`]) {
        const t = performance.now();
        redact(line, empty);
        gate(line, empty);
        expect(performance.now() - t).toBeLessThan(1000);
      }
    } finally {
      useSecretRules(await importSecretRules(RULES));
    }
  });
});

describe("short names in capitals and kernel releases", () => {
  test("a short hidden name in capitals is not found inside a word of capitals, and is in a camel-case one", () => {
    const d: Dictionary = { entries: [{ value: "SK", label: "<customer-1>", kind: "named" }] };
    expect(redact("STAGE_SKIPPED and LGTM", d)).toBe("STAGE_SKIPPED and LGTM");
    expect(redact("the SK team and SKClient", d)).toBe("the <customer-1> team and <customer-1>Client");
  });
  test("a WSL kernel release is not an address", () => {
    expect(redact("linux 5.15.167.4-microsoft-standard-WSL2 x64", empty)).toBe("linux 5.15.167.4-microsoft-standard-WSL2 x64");
    expect(redact("from 10.20.30.40 today", empty)).toBe("from <ip> today");
  });
});
