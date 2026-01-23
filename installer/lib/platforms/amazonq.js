const path = require('path');
const fs = require('fs-extra');

class AmazonQHandler {
  constructor() {
    this.platform = 'amazonq';
    this.displayName = 'Amazon Q Developer IDE';
  }

  getInstallPaths(targetDir) {
    return {
      rulesDestination: path.join(targetDir, '.amazonq', 'rules', 'aws-aidlc-rules'),
      detailsDestination: path.join(targetDir, '.amazonq', 'aws-aidlc-rule-details'),
      parentDirectories: [
        path.join(targetDir, '.amazonq'),
        path.join(targetDir, '.amazonq', 'rules')
      ]
    };
  }

  getVerificationInstructions() {
    return `To verify AI-DLC rules are loaded:
1. Open the Amazon Q Chat window in your IDE
2. Click the "Rules" button in the lower right corner
3. Verify you see entries for ".amazonq/rules/aws-aidlc-rules"`;
  }

  async isInstalled(targetDir) {
    const paths = this.getInstallPaths(targetDir);
    const rulesExist = await fs.pathExists(paths.rulesDestination);
    const detailsExist = await fs.pathExists(paths.detailsDestination);
    return rulesExist || detailsExist;
  }
}

module.exports = { AmazonQHandler };
