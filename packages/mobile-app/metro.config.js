const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.resolver.assetExts = [
  ...(config.resolver.assetExts || []),
  'wasm',
];

config.watchFolders = [workspaceRoot];
config.resolver.blockList = [
  ...(config.resolver.blockList || []),
  new RegExp(
    `${path
      .resolve(workspaceRoot, 'storage/files')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/].*`,
  ),
];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
