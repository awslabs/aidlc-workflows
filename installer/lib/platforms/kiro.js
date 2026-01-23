const path = require('path');
const fs = require('fs-extra');

class KiroHandler {
  constructor(platform = 'kiro-cli') {
    this.platform = platform;
    this.displayName = platform === 'kiro-ide' ? 'Kiro IDE' : 'Kiro CLI';
  }

  getInstallPaths(targetDir) {
    return {
      rulesDestination: path.join(targetDir, '.kiro', 'steering', 'aws-aidlc-rules'),
      detailsDestination: path.join(targetDir, '.kiro', 'aws-aidlc-rule-details'),
      parentDirectories: [
        path.join(targetDir, '.kiro'),
        path.join(targetDir, '.kiro', 'steering')
      ]
    };
  }

  getVerificationInstructions() {
    if (this.platform === 'kiro-ide') {
      return `To verify AI-DLC rules are loaded:
1. Open Kiro IDE
2. Check the steering files panel
3. Verify you see entries for ".kiro/steering/aws-aidlc-rules"`;
    }
    return `To verify AI-DLC rules are loaded:
1. Start Kiro CLI: kiro-cli
2. Check your context contents: /context show
3. Verify you see entries for ".kiro/steering/aws-aidlc-rules"`;
  }

  async isInstalled(targetDir) {
    const paths = this.getInstallPaths(targetDir);
    const rulesExist = await fs.pathExists(paths.rulesDestination);
    const detailsExist = await fs.pathExists(paths.detailsDestination);
    return rulesExist || detailsExist;
  }
}

module.exports = { KiroHandler };
