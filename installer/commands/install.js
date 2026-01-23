const path = require('path');
const installer = require('../lib/installer');
const fileManager = require('../lib/file-manager');
const ui = require('../lib/ui');

async function installCommand(options) {
  ui.displayIntro();

  // Resolve target directory
  const targetDirectory = options.path
    ? path.resolve(options.path)
    : process.cwd();

  // Validate target directory exists
  const exists = await fileManager.directoryExists(targetDirectory);
  if (!exists) {
    ui.displayError({
      message: `Directory not found: ${targetDirectory}`,
      remediation: 'Create the directory first or check the path'
    });
    process.exit(1);
  }

  // Prompt for platform selection
  const platform = await ui.promptPlatformSelection();

  // Run installation
  const result = await installer.install({
    targetDirectory,
    platform,
    force: options.force
  });

  if (result.cancelled) {
    process.exit(0);
  }

  if (!result.success) {
    ui.displayError(result.error);
    process.exit(1);
  }

  // Display success and next steps
  ui.displaySuccess(result);
  ui.displayVerificationInstructions(platform);
  ui.displayNextSteps();
}

module.exports = { installCommand };
