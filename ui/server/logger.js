/* eslint-disable no-console,prefer-destructuring */
const chalk = require('chalk');
const ip = require('ip');
const isString = require('lodash/isString');
const util = require('util');
const inspect = util.inspect;

const divider = chalk.gray('\n-----------------------------------');
const inspectLog = message => {
  if (isString(message)) {
    return message;
  }
  return inspect(message, false, 5, true);
};
/**
 * Logger middleware, you can customize it to make messages more personal
 */
const logger = {
  // Called whenever there's an error on the server we want to print
  error: err => {
    console.error(inspectLog(chalk.red(err)));
  },
  log: message => {
    console.log(inspectLog(message));
  },

  // Called when express.js app starts on given port w/o errors
  appStarted: (port, host, tunnelStarted) => {
    console.log(`Server started ! ${chalk.green('✓')}`);

    // If the tunnel started, log that and the URL it's available at
    if (tunnelStarted) {
      console.log(`Tunnel initialised ${chalk.green('✓')}`);
    }

    console.log(`
${chalk.bold('Access URLs:')}${divider}
Localhost: ${chalk.magenta(`http://${host}:${port}`)}
      LAN: ${chalk.magenta(`http://${ip.address()}:${port}`) +
        (tunnelStarted
          ? `\n    Proxy: ${chalk.magenta(tunnelStarted)}`
          : '')}${divider}
${chalk.blue(`Press ${chalk.italic('CTRL-C')} to stop`)}
    `);
  },
};

module.exports = logger;
