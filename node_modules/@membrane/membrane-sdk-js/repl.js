let watch = require('watch');
let process = require('process');

// Listen for changes in the lib folder and exit once it changes, this should
// make repl.sh start over
closeOnNextChange = false;
watch.watchTree('./lib', {
  ignoreDotFiles: true,
  interval: 0.5,
}, (f, curr, prev) => {
  if (typeof f === "object" && !prev && !curr) {
    closeOnNextChange = true;
  } else {
    if (closeOnNextChange)
      process.exit(0);
  }
});

Object.assign(global, require('.'));

