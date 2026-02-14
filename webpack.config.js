//@ts-check
'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration[]} */
const configs = [
  // Extension host bundle
  {
    name: 'extension',
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
    },
    externals: {
      vscode: 'commonjs vscode',
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }],
        },
      ],
    },
    devtool: 'nosources-source-map',
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'src/webview/index.html', to: 'webview/index.html' },
          { from: 'src/webview/style.css', to: 'webview/style.css' },
          { from: 'src/webview/script.js', to: 'webview/script.js' },
        ],
      }),
    ],
  },
  // Worker bundle (standalone, no vscode dependency)
  {
    name: 'worker',
    target: 'node',
    mode: 'none',
    entry: './src/worker/analyzerWorker.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'analyzerWorker.js',
      libraryTarget: 'commonjs2',
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }],
        },
      ],
    },
    devtool: 'nosources-source-map',
  },
];

module.exports = configs;
