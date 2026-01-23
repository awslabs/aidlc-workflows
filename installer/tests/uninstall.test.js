import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import installer from '../lib/installer.js';
import { getPlatformHandler } from '../lib/platforms/index.js';

describe('Uninstall Flow', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-test-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), '{}');
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('should uninstall and remove only AI-DLC files', async () => {
    await installer.install({
      targetDirectory: tempDir,
      platform: 'amazonq',
      force: true
    });

    const otherFile = path.join(tempDir, '.amazonq', 'other-config.json');
    await fs.writeFile(otherFile, '{}');

    const result = await installer.uninstall({
      targetDirectory: tempDir,
      platform: 'amazonq',
      force: true
    });

    expect(result.success).toBe(true);

    const handler = getPlatformHandler('amazonq');
    const paths = handler.getInstallPaths(tempDir);
    expect(await fs.pathExists(paths.rulesDestination)).toBe(false);
    expect(await fs.pathExists(paths.detailsDestination)).toBe(false);
    expect(await fs.pathExists(otherFile)).toBe(true);
  });

  it('should return notInstalled when no installation present', async () => {
    const result = await installer.uninstall({
      targetDirectory: tempDir,
      platform: 'amazonq',
      force: true
    });

    expect(result.success).toBe(false);
    expect(result.notInstalled).toBe(true);
  });

  it('should uninstall kiro-cli installation', async () => {
    await installer.install({
      targetDirectory: tempDir,
      platform: 'kiro-cli',
      force: true
    });

    const result = await installer.uninstall({
      targetDirectory: tempDir,
      platform: 'kiro-cli',
      force: true
    });

    expect(result.success).toBe(true);

    const handler = getPlatformHandler('kiro-cli');
    const paths = handler.getInstallPaths(tempDir);
    expect(await fs.pathExists(paths.rulesDestination)).toBe(false);
    expect(await fs.pathExists(paths.detailsDestination)).toBe(false);
  });
});
