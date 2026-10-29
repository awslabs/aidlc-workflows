#!/usr/bin/env bun
/**
 * mabl-verification-doctor.ts
 *
 * Plugin doctor check for mabl-verification.
 * Verifies the mabl CLI is installed and authenticated, and that the sensor
 * manifests are correctly placed.
 *
 * Invoked by `/aidlc --doctor` with env vars:
 *   AIDLC_PROJECT_DIR  — project root
 *   AIDLC_HARNESS_DIR  — harness directory name (e.g. ".kiro", ".claude")
 *   AIDLC_PLUGIN_NAME  — "mabl-verification"
 *
 * Writes a JSON object to stdout with a `checks` array.
 * Each check: { pass: boolean, label: string, fix?: string, severity?: "error" | "advisory" }
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

interface Check {
  pass: boolean;
  label: string;
  fix?: string;
  severity?: "error" | "advisory";
}

function checkCliInstalled(): Check {
  try {
    const version = execSync("mabl --version", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return {
      pass: true,
      label: `mabl CLI installed (${version})`,
    };
  } catch {
    return {
      pass: false,
      label: "mabl CLI is not installed or not on PATH",
      fix: "Install with: npm install -g @mablhq/mabl-cli",
      severity: "error",
    };
  }
}

function checkCliAuthenticated(): Check {
  try {
    const authInfo = execSync("mabl auth info 2>&1", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Check for common "not logged in" indicators
    if (
      authInfo.includes("not logged in") ||
      authInfo.includes("No authentication") ||
      authInfo.includes("expired")
    ) {
      return {
        pass: false,
        label: "mabl CLI is not authenticated",
        fix: "Run: mabl auth login (or mabl auth activate-key <api-key>)",
        severity: "error",
      };
    }

    return {
      pass: true,
      label: "mabl CLI authenticated",
    };
  } catch {
    return {
      pass: false,
      label: "mabl CLI authentication check failed",
      fix: "Run: mabl auth login (or mabl auth activate-key <api-key>)",
      severity: "advisory",
    };
  }
}

function checkWorkspaceConfigured(): Check {
  try {
    const wsId = execSync("mabl config get workspace-id 2>&1", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!wsId || wsId.includes("not set") || wsId.includes("undefined")) {
      return {
        pass: false,
        label: "mabl workspace-id not configured",
        fix: "Run: mabl config set workspace-id <your-workspace-id>",
        severity: "advisory",
      };
    }

    return {
      pass: true,
      label: `mabl workspace configured (${wsId.substring(0, 12)}...)`,
    };
  } catch {
    return {
      pass: false,
      label: "mabl workspace-id not configured",
      fix: "Run: mabl config set workspace-id <your-workspace-id> (or provide via team knowledge)",
      severity: "advisory",
    };
  }
}

function checkSensorsInstalled(): Check {
  const projectDir = process.env.AIDLC_PROJECT_DIR || process.cwd();
  const harnessDir = process.env.AIDLC_HARNESS_DIR || ".kiro";
  const sensorsDir = join(projectDir, harnessDir, "sensors");

  const expectedSensors = [
    "aidlc-mabl-run-status.md",
    "aidlc-mabl-coverage-threshold.md",
  ];

  const missing: string[] = [];
  for (const sensor of expectedSensors) {
    if (!existsSync(join(sensorsDir, sensor))) {
      missing.push(sensor);
    }
  }

  if (missing.length > 0) {
    return {
      pass: false,
      label: `mabl-verification sensors not composed: ${missing.join(", ")}`,
      fix: "Re-run plugin compose: aidlc plugin sync (or bun <plugin>/hooks/compose.ts)",
      severity: "advisory",
    };
  }

  return {
    pass: true,
    label: "mabl-verification sensors composed",
  };
}

function checkAgentInstalled(): Check {
  const projectDir = process.env.AIDLC_PROJECT_DIR || process.cwd();
  const harnessDir = process.env.AIDLC_HARNESS_DIR || ".kiro";
  const agentPath = join(
    projectDir,
    harnessDir,
    "agents",
    "mabl-verification-agent.md"
  );

  if (!existsSync(agentPath)) {
    return {
      pass: false,
      label: "mabl-verification-agent not composed into harness",
      fix: "Re-run plugin compose: aidlc plugin sync (or bun <plugin>/hooks/compose.ts)",
      severity: "advisory",
    };
  }

  return {
    pass: true,
    label: "mabl-verification-agent composed",
  };
}

function checkScopeInstalled(): Check {
  const projectDir = process.env.AIDLC_PROJECT_DIR || process.cwd();
  const harnessDir = process.env.AIDLC_HARNESS_DIR || ".kiro";
  const scopePath = join(
    projectDir,
    harnessDir,
    "scopes",
    "mabl-verification-validation.md"
  );

  if (!existsSync(scopePath)) {
    return {
      pass: false,
      label: "mabl-verification-validation scope not composed",
      fix: "Re-run plugin compose: aidlc plugin sync (or bun <plugin>/hooks/compose.ts)",
      severity: "advisory",
    };
  }

  return {
    pass: true,
    label: "mabl-verification-validation scope composed",
  };
}

function main(): void {
  const checks: Check[] = [
    checkCliInstalled(),
    checkCliAuthenticated(),
    checkWorkspaceConfigured(),
    checkSensorsInstalled(),
    checkAgentInstalled(),
    checkScopeInstalled(),
  ];

  console.log(JSON.stringify({ checks }));
}

main();
