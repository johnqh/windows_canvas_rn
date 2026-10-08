// `.cjs`, not `.js`: this package is `"type": "module"`, so a `.js` file here
// is loaded as ESM and its `module.exports` is never seen.
module.exports = {
  dependency: {
    platforms: {
      ios: null,
      android: null,
      macos: null,
      // Consumers compile windows/*.cpp into their own React Native Windows
      // project and register the view; see README.md.
      windows: null,
    },
  },
};
