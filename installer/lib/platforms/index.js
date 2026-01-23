const { AmazonQHandler } = require('./amazonq');
const { KiroHandler } = require('./kiro');

const platforms = {
  amazonq: new AmazonQHandler(),
  'kiro-cli': new KiroHandler('kiro-cli'),
  'kiro-ide': new KiroHandler('kiro-ide')
};

const platformList = [
  { value: 'amazonq', label: 'Amazon Q Developer IDE' },
  { value: 'kiro-cli', label: 'Kiro CLI' },
  { value: 'kiro-ide', label: 'Kiro IDE' }
];

function getPlatformHandler(platform) {
  return platforms[platform];
}

function getSupportedPlatforms() {
  return platformList;
}

module.exports = {
  getPlatformHandler,
  getSupportedPlatforms,
  platforms
};
