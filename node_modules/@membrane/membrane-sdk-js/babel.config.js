module.exports = {
  presets: [
    [
      "@babel/preset-env",
      {
        targets: {
          node: "10",
        },
      },
    ],
  ],
  plugins: [
    "@babel/plugin-proposal-object-rest-spread",
    "@babel/plugin-transform-flow-strip-types",
    "@babel/plugin-proposal-class-properties",
    "@babel/plugin-proposal-export-default-from",
  ],
};
