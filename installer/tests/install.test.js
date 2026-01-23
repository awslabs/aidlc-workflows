import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import installer from '../lib/installer.js';
import { getPlatformHandler } from '../lib/platforms/index.js';

describe('Install Flow', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-test-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), '{}');
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('should install to empty directory for amazonq', async () => {
    const result = await installer.install({
      targetDirectory: tempDir,
      platform: 'amazonq',
      force: true
    });

    expect(result.success).toBe(true);
    expect(result.platform).toBe('amazonq');

    const handler = getPlatformHandler('amazonq');
    const paths = handler.getInstallPaths(tempDir);
    expect(await fs.pathExists(paths.rulesDestination)).toBe(true);
    expect(await fs.pathExists(paths.detailsDestination)).toBe(true);
  });

  it('should install to empty directory for kiro-cli', async () => {
    const result = await installer.install({
      targetDirectory: tempDir,
      platform: 'kiro-cli',
      force: true
    });

    expect(result.success).toBe(true);
    expect(result.platform).toBe('kiro-cli');

    const handler = getPlatformHandler('kiro-cli');
    const paths = handler.getInstallPaths(tempDir);
    expect(await fs.pathExists(paths.rulesDestination)).toBe(true);
    expect(await fs.pathExists(paths.detailsDestination)).toBe(true);
  });

  it('should update existing installation with force flag', async () => {
    await installer.install({
      targetDirectory: tempDir,
      platform: 'amazonq',
      force: true
    });

    const result = await installer.install({
      targetDirectory: tempDir,
      platform: 'amazonq',
      force: true
    });

    expect(result.success).toBe(true);
  });

  it('should detect existing installation', async () => {
    await installer.install({
      targetDirectory: tempDir,
      platform: 'kiro-cli',
      force: true
    });

    const existing = await installer.detectExistingInstallation(tempDir);
    expect(existing).not.toBeNull();
    expect(existing.platform).toBe('kiro-cli');
  });

  it('should return null for directory without installation', async () => {
    const existing = await installer.detectExistingInstallation(tempDir);
    expect(existing).toBeNull();
  });

  it('should install rules without nested duplicate folders', async () => {
    await installer.install({
      targetDirectory: tempDir,
      platform: 'kiro-cli',
      force: true
    });

    // core-workflow.md should be at .kiro/steering/aws-aidlc-rules/core-workflow.md
    const correctPath = path.join(tempDir, '.kiro', 'steering', 'aws-aidlc-rules', 'core-workflow.md');
    expect(await fs.pathExists(correctPath)).toBe(true);
  });

  it('should install rule-details with correct structure', async () => {
    await installer.install({
      targetDirectory: tempDir,
      platform: 'kiro-cli',
      force: true
    });

    // Verify aws-aidlc-rule-details structure
    const detailsBase = path.join(tempDir, '.kiro', 'aws-aidlc-rule-details');

    // Check subdirectories exist
    expect(await fs.pathExists(path.join(detailsBase, 'common'))).toBe(true);
    expect(await fs.pathExists(path.join(detailsBase, 'construction'))).toBe(true);
    expect(await fs.pathExists(path.join(detailsBase, 'inception'))).toBe(true);
    expect(await fs.pathExists(path.join(detailsBase, 'operations'))).toBe(true);

    // Check some key files exist at correct paths
    expect(await fs.pathExists(path.join(detailsBase, 'common', 'process-overview.md'))).toBe(true);
    expect(await fs.pathExists(path.join(detailsBase, 'inception', 'requirements-analysis.md'))).toBe(true);
    expect(await fs.pathExists(path.join(detailsBase, 'construction', 'code-generation.md'))).toBe(true);
    expect(await fs.pathExists(path.join(detailsBase, 'operations', 'operations.md'))).toBe(true);

    // Verify no nested duplicate folder
    expect(await fs.pathExists(path.join(detailsBase, 'aws-aidlc-rule-details'))).toBe(false);
  });
});
