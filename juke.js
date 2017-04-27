'use strict';

// grouped full modules a-z
const DigitalOceanApi = require('doapi');
const NodeSSH = require('node-ssh');
const inquirer = require('inquirer');

// grouped module methods a-z
const Readable = require('stream').Readable;

// grouped global constants, a-z
// path of configuration files that need to be edited on remote server
const configurations = {
  shadowsocks: {
    'config.json': '/etc/shadowsocks-libev/config.json',
  },
};
const prompt = inquirer.createPromptModule();
const promptQuestions = [{
  type: 'input',
  name: 'do_api_token',
  message: 'Digital Ocean token:',
}, {
  type: 'input',
  name: 'ssh_key_location',
  message: 'Name of SSH key in ~/.ssh/ to connect to Streisand droplet:',
}, {
  type: 'input',
  name: 'domain',
  message: 'domain tied to Streisand:',
}];
const ssh = new NodeSSH();
const time = new Date();

let client;
let sshKey;

// gather required info from user
function getSessionInfo() {
  const sessionInfo = {
    do_api_token: null,
    ssh_key_location: null,
  };

  return prompt(promptQuestions).then((answers) => {
    sessionInfo.do_api_token = answers.do_api_token;
    sessionInfo.ssh_key_location = answers.ssh_key_location;
    sessionInfo.domain = answers.domain;
    sshKey = {
      location: `${process.env.HOME}/.ssh/${sessionInfo.ssh_key_location}`,
      doID: [],
    };

    client = new DigitalOceanApi({
      token: sessionInfo.do_api_token,
    });
    return sessionInfo;
  }).then(() => {
    let keys;
    return client.sshKeyGetAll().then((results) => {
      keys = results.filter(result => result.name === sessionInfo.ssh_key_location);
      if (keys[0].name === sessionInfo.ssh_key_location) {
        sshKey.doID.push(keys[0].id);
        console.log('Remote key found');
        return sessionInfo;
      }
      console.error('SSH Key not found on DO, aborting . . .');
      process.exit(1);
    });
  }).catch(error => console.log(error));
}

// find the latest instance of streisand from Digital Ocean and store it.
function getCurrentServer(sessionInfo) {
  console.log('finding current instance of Streisand. . .');
  return client.dropletGetAll().then(droplets => droplets.filter((el) => {
    if (el.name.search('streisand-') !== -1) {
      return el.name;
    }
    return console.log('Could not find a droplet name starting with "streisand-" ');
  })).then((droplet) => {
    sessionInfo.old_server = droplet[0];
    console.log(`The current server is: ${sessionInfo.old_server.name
      } ${sessionInfo.old_server.networks.v4[0].ip_address}`);
    return sessionInfo;
  }).catch(error => console.error(error));
}

// using the return from getCurrentServer, start a new droplet using the snapshot of the old server.
function startNewServer(sessionInfo) {
  let image;
  if (!sessionInfo.old_server.snapshot_ids[0]) {
    image = sessionInfo.old_server.image.id;
  } else image = sessionInfo.old_server.snapshot_ids[0];

  let newServerDetails = {
    name: `streisand-${time.getMonth() + 1}-${time.getDate()
      }-${time.getHours()}.${time.getMinutes()}`,
    region: sessionInfo.old_server.region.slug,
    size: '512mb',
    image,
    ssh_keys: sshKey.doID,
  };

  console.log('starting new droplet. . .');

  return client.dropletNew(newServerDetails).then((newDroplet) => {
    newServerDetails = newDroplet;
    let numAttempts = 0;

    function getIP() {
      return client.dropletGet(newServerDetails.id).then((startingDroplet) => {
        numAttempts += 1;
        console.log('Find IP attempt # ', numAttempts);

        if (startingDroplet.networks.v4[0].ip_address !== undefined) {
          newServerDetails = startingDroplet;
          console.log('newServer updated with IPv4 address: ',
            startingDroplet.networks.v4[0].ip_address);
          return newServerDetails;
        } else if (numAttempts > 15) {
          return console.log(`failed to reach server after ${numAttempts} attempts`);
        }
        return getIP();
      }).then((server) => {
        sessionInfo.new_server = server;
        console.log(`${sessionInfo.new_server.name} ${
          sessionInfo.new_server.networks.v4[0].ip_address}`);
        return sessionInfo;
      });
    }
    return getIP();
  }).catch(error => console.log(error));
}

// check if the new_server is online and reachable by ssh
function checkConnection(sessionInfo) {
  const execUptime = sessionInfo => ssh.connect({
    host: sessionInfo.new_server.networks.v4[0].ip_address,
    username: 'root',
    privateKey: sshKey.location,
  }).then(() => ssh.execCommand('uptime'));

  function tryConnect() {
    let attempt = 0;

    function loop() {
      console.log(`Attempting to connect to server ${sessionInfo.new_server.name}. . . `);
      console.log(`Attempt: ${attempt + 1}`);
      return execUptime(sessionInfo).then((results) => {
        if (results.hasOwnProperty('stdout') || results.hasOwnProperty('stderr')) {
          if (results.hasOwnProperty('stdout')) {
            console.log(`STDOUT: ${results.stdout}`);
            return sessionInfo;
          } else if (results.hasOwnProperty('stderr')) {
            console.log(`command failed - STDERR: ${results.stderr}`);
            attempt += 1;
            if (attempt !== 10) {
              console.log('trying again . . . ');
              return loop();
            }
          }
        } else {
          console.log(`unknown failure: ${results}`);
          process.exit(1);
        }
       // whoah, I have the loop logic in here twice now. Not sure which one actually works. Rework.
      }).catch((error) => {
        console.log('failed to connect . . . ');
        attempt += 1;
        console.error(error);
        if (attempt !== 25) {
          console.log('trying again . . . ');
          return loop();
        }
        console.log(`failed to connect after ${attempt} attempts`);
        return process.exit(1);
      });
    }
    return loop();
  }
  return tryConnect();
}

// download, update, and upload Shadowsocks config file
function getShadowsocks(sessionInfo) {
  console.log('updating Shadowsocks. . . ');

  function readConfig(service, config) {
    sessionInfo[service] = {};
    sessionInfo[service][config] = config;
    const streamOpts = {
      flags: 'r',
      encoding: 'utf-8',
      handle: null,
      mode: 0o666,
      autoClose: true,
    };

    const streamData = [];

    return ssh.connect({
      host: sessionInfo.old_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey.location,
    }).then(session => session.requestSFTP().then((sftp) => {
      console.log(`successfully connected, downloading ${config}`);
      const readStream = sftp.createReadStream(configurations[service][config], streamOpts);
      const stream = new Promise((resolve, reject) => {
        readStream.on('data', (data) => {
          streamData.push(data);
        });
        readStream.on('end', () => {
          console.log(`${config} was successfully downloaded . . . `);
          sessionInfo[service][config] = JSON.parse(streamData);
          sessionInfo[service][config].server = sessionInfo.new_server.networks.v4[0].ip_address;
          resolve();
        });
        readStream.on('error', () => reject(process.exit(1)));
      });
      return stream;
    }).catch((STFPerror) => {
      console.error(STFPerror);
      process.exit(1);
    }))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }

  function writeConfig(service, config) {
    const streamOpts = {
      flags: 'w',
      encoding: 'utf-8',
      handle: null,
      mode: 0o666,
      autoClose: true,
    };

    return ssh.connect({
      host: sessionInfo.new_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey.location,
    }).then(session => session.requestSFTP().then((sftp) => {
      const configReadable = new Readable();
      const writeStream = sftp.createWriteStream(configurations[service][config], streamOpts);
      const stream = new Promise((resolve) => {
        writeStream.on('close', () => {
          console.log(`${config} transferred succesfully`);
          resolve();
        });
      });

      configReadable.push(`${JSON.stringify(sessionInfo[service][config], null, 2)}\n`);
      configReadable.push(null);
      configReadable.pipe(writeStream);
      return stream;
    }).catch(error => console.error(error)));
  }

  return readConfig('shadowsocks', 'config.json').then(() => writeConfig('shadowsocks', 'config.json'))
  .then(() => serviceRestart('shadowsocks-libev', sessionInfo))
  .then((results) => {
    console.log(results);
    return results;
  })
  .catch((error) => {
    console.error(error);
  });
}


// restart a specified service on the new_server
function serviceRestart(service, sessionInfo) {
  console.log(`restarting ${service}`);
  return ssh.connect({
    host: sessionInfo.new_server.networks.v4[0].ip_address,
    username: 'root',
    privateKey: sshKey.location,
  })
  .then(() => ssh.execCommand(`service ${service} restart && service ${service} status`))
  .then((results) => {
    if (results.hasOwnProperty('stdout') || results.hasOwnProperty('stderr')) {
      if (results.hasOwnProperty('stdout')) {
        console.log(`STDOUT: ${results.stdout}`);
        return sessionInfo;
      }
      return console.error(`STDERR: ${results.stderr}`);
    }
    return console.error(`unknown error: ${results}`);
  }).catch(error => console.error(error));
}
// update the specified domain A record on Digital Ocean
function updateDomainRecords(sessionInfo) {
  console.log('updating domain record . . .');
  const domain = sessionInfo.domain;
  return client.domainRecordGetAll(domain).then((domainRecords) => {
    const newRecord = {
      type: 'A',
      data: sessionInfo.new_server.networks.v4[0].ip_address,
      name: '@',
    };
    let targetRecord = domainRecords.filter(() => domainRecords);
    if (targetRecord != null) {
      targetRecord = targetRecord.filter(el => el.type === 'A');
      if (targetRecord[0].data === sessionInfo.old_server.networks.v4[0].ip_address) {
        return console.log('the targetRecord and current server record match, updating record');
      }
      console.error('DNS Records do not match, skipping DNS record update.');
      return client.domainRecordEdit(domain, targetRecord[0].id, newRecord)
      .then((updatedRecord) => {
        sessionInfo.domain = updatedRecord;
        return console.error('The new record is : \n', sessionInfo.domain);
      });
    } else if (!targetRecord[0]) {
      console.error(`The record details could not be found, skipping DNS record update ${targetRecord}`);
      return sessionInfo;
    }
    return console.error(`unknown error ${targetRecord}`);
  }).then(() => sessionInfo).catch((error) => {
    console.error(`There was an error when trying to look up the domain, skipping DNS record update:\n ${error}`);
    return sessionInfo;
  });
}

function destroyServer(sessionInfo) {
  return client.dropletDestroy(sessionInfo.old_server.id).then((results) => {
    console.log(results);
    return sessionInfo;
  }).catch(error => console.error(error));
}

// run the program
getSessionInfo()
  .then(results => getCurrentServer(results))
  .then(results => startNewServer(results))
  .then(results => checkConnection(results))
  .then(results => getShadowsocks(results))
  .then(results => updateDomainRecords(results))
  .then((results) => {
    const latestResults = results;
    return prompt([{
      type: 'confirm',
      name: 'destroy',
      message: 'Would you like to destroy the old Droplet?',
    }]).then((answers) => {
      if (answers.destroy) {
        return destroyServer(latestResults);
      }
      return latestResults;
    }).catch(error => console.log(error));
  })
  .then((results) => {
    console.log(`redeployment complete: \n${results.new_server.networks.v4[0].ip_address}`);
    return process.exit();
  });
