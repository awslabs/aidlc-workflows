const { select, confirm, spinner, intro, outro, note, cancel, isCancel } = require('@clack/prompts');
const { getSupportedPlatforms, getPlatformHandler } = require('./platforms');

// ANSI color codes
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

async function promptPlatformSelection() {
  const platforms = getSupportedPlatforms();
  const result = await select({
    message: 'Select the platform to install AI-DLC for:',
    options: platforms.map(p => ({ value: p.value, label: p.label }))
  });

  if (isCancel(result)) {
    cancel('Installation cancelled.');
    process.exit(0);
  }

  return result;
}

async function promptExistingInstallation(platform) {
  const handler = getPlatformHandler(platform);
  const result = await select({
    message: `AI-DLC is already installed for ${handler.displayName}. What would you like to do?`,
    options: [
      { value: 'update', label: 'Update - Remove existing and install fresh' },
      { value: 'cancel', label: 'Cancel - Keep existing installation' }
    ]
  });

  if (isCancel(result)) {
    cancel('Installation cancelled.');
    process.exit(0);
  }

  return result;
}

async function promptUninstallConfirmation(platform) {
  const handler = getPlatformHandler(platform);
  const result = await confirm({
    message: `Are you sure you want to remove AI-DLC from ${handler.displayName}?`
  });

  if (isCancel(result)) {
    cancel('Uninstall cancelled.');
    process.exit(0);
  }

  return result;
}

function startSpinner(message) {
  const s = spinner();
  s.start(message);
  return s;
}

function displayIntro() {
  intro(`${colors.cyan}${colors.bold}AI-DLC Installer${colors.reset}`);
}

function displaySuccess(result) {
  const handler = getPlatformHandler(result.platform);
  outro(`${colors.green}✓${colors.reset} AI-DLC installed successfully for ${handler.displayName}`);
}

function displayError(error) {
  console.error(`\n${colors.red}✗ Error:${colors.reset} ${error.message}`);
  if (error.remediation) {
    console.error(`${colors.yellow}→${colors.reset} ${error.remediation}`);
  }
}

function displayVerificationInstructions(platform) {
  const handler = getPlatformHandler(platform);
  note(handler.getVerificationInstructions(), 'Verification');
}

function displayNextSteps() {
  note(`Start any software development project by stating your intent
starting with the phrase "Using AI-DLC, ..." in the chat.`, 'Next Steps');
}

function displayUninstallSuccess(result) {
  outro(`${colors.green}✓${colors.reset} AI-DLC uninstalled successfully`);
  if (result.directoriesRemoved.length > 0) {
    console.log(`\nRemoved directories:`);
    result.directoriesRemoved.forEach(dir => {
      console.log(`  ${colors.yellow}→${colors.reset} ${dir}`);
    });
  }
}

module.exports = {
  promptPlatformSelection,
  promptExistingInstallation,
  promptUninstallConfirmation,
  startSpinner,
  displayIntro,
  displaySuccess,
  displayError,
  displayVerificationInstructions,
  displayNextSteps,
  displayUninstallSuccess
};
