const path = require('path');
const fs = require('fs-extra');

// Get path to bundled rules within the npm package
function getBundledRulesPath() {
  return path.join(__dirname, '..', '..', 'aidlc-rules', 'aws-aidlc-rules');
}

function getBundledDetailsPath() {
  return path.join(__dirname, '..', '..', 'aidlc-rules', 'aws-aidlc-rule-details');
}

// Copy directory recursively
async function copyDirectory(source, destination) {
  try {
    await fs.copy(source, destination, { overwrite: true });
    const files = await countFiles(destination);
    return { success: true, filesCopied: files, errors: [] };
  } catch (error) {
    return { success: false, filesCopied: 0, errors: [error.message] };
  }
}

// Count files in directory recursively
async function countFiles(dir) {
  let count = 0;
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.isFile()) {
      count++;
    } else if (item.isDirectory()) {
      count += await countFiles(path.join(dir, item.name));
    }
  }
  return count;
}

// Remove AI-DLC specific files safely
async function removeAIDLCFiles(paths) {
  const filesRemoved = [];
  const directoriesRemoved = [];

  try {
    if (await fs.pathExists(paths.rulesDestination)) {
      await fs.remove(paths.rulesDestination);
      directoriesRemoved.push(paths.rulesDestination);
    }
    if (await fs.pathExists(paths.detailsDestination)) {
      await fs.remove(paths.detailsDestination);
      directoriesRemoved.push(paths.detailsDestination);
    }
    return { success: true, filesRemoved, directoriesRemoved };
  } catch (error) {
    return { success: false, filesRemoved, directoriesRemoved, error: error.message };
  }
}

// Check if directory exists
async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// Create directory if it doesn't exist
async function ensureDirectory(dirPath) {
  await fs.ensureDir(dirPath);
}

module.exports = {
  getBundledRulesPath,
  getBundledDetailsPath,
  copyDirectory,
  removeAIDLCFiles,
  directoryExists,
  ensureDirectory
};
