"use strict"
var DigitalOceanApi = require('doapi')
var fs = require('fs')
var node_ssh = require('node-ssh')
var inquirer = require('inquirer')

var readable = require('stream').Readable

var client
var sshKey
var ssh = new node_ssh()

var configurations = {
  shadowsocks: {
    'config.json': '/etc/shadowsocks-libev/config.json'
  }
};
const prompt = inquirer.createPromptModule()
const promptQuestions = [{
  type: 'input',
  name: 'do_api_token',
  message: 'Digital Ocean token:'
}, {
  type: 'input',
  name: 'ssh_key_location',
  message: 'Name of SSH key in ~/.ssh/ to connect to Streisand droplet:'
}, {
  type: 'input',
  name: 'domain',
  message: 'domain tied to Streisand:'
}]
var time = new Date()

//gather required info from user
function getSessionInfo() {
  var sessionInfo = {
    do_api_token: null,
    ssh_key_location: null
  }

  return prompt(promptQuestions).then(answers => {
    sessionInfo.do_api_token = answers.do_api_token
    sessionInfo.ssh_key_location = answers.ssh_key_location
    sessionInfo.domain = answers.domain
    sshKey = process.env.HOME + '/.ssh/' + sessionInfo.ssh_key_location
    client = new DigitalOceanApi({
      token: sessionInfo.do_api_token
    })
    return sessionInfo
  }).catch(error => console.log(error))
}

//find the latest instance of streisand from Digital Ocean and store it.
function getCurrentServer(sessionInfo) {
  console.log('finding current instance of Streisand. . .')
  return client.dropletGetAll().then(droplets => {
    return droplets.filter(el => {
      if (el.name.search('streisand-') !== -1) {
        return el.name
      }
    })
  }).then(droplet => {
    sessionInfo.old_server = droplet[0];
    console.log('The current server is: ' + sessionInfo.old_server.name +
      " " + sessionInfo.old_server.networks.v4[0].ip_address)
    return sessionInfo
  }).catch(error => console.error(error))
}

//using the return from getCurrentServer, start a new droplet using the snapshot of the old server.
function startNewServer(sessionInfo) {
  const image
  if(!sessionInfo.old_server.snapshot_ids[0]){
    image = sessionInfo.old_server.image.id
  } else image = sessionInfo.old_server.snapshot_ids[0]

  var newServerDetails = {
    "name": "streisand-" + (time.getMonth() + 1) + "-" + time.getDate() +
      "-" + time.getHours() + "." + time.getMinutes(),
    "region": "sfo2",
    //"region": oldServer.oldserver.region.slug,
    "size": "512mb",
    "image": image,
    "ssh_keys": [1278744]
  }
  console.log('starting new droplet. . .')

  return client.dropletNew(newServerDetails).then(newDroplet => {
    newServerDetails = newDroplet
    var numAttempts = 0

    function getIP() {

      return client.dropletGet(newServerDetails.id).then(startingDroplet => {
        numAttempts++
        console.log("Find IP attempt # ", numAttempts)

        if (startingDroplet.networks.v4[0].ip_address != undefined) {
          newServerDetails = startingDroplet;
          console.log("newServer updated with IPv4 address: ",
            startingDroplet.networks.v4[0].ip_address);
          return newServerDetails;

        } else {
          if (numAttempts > 15) {
            console.log("failed to reach server after " + numAttempts +
              " attempts");
          } else {
            return getIP()
          }
        }
      }).then(server => {
        sessionInfo.new_server = server
        console.log(sessionInfo.new_server.name + " " +
          sessionInfo.new_server.networks.v4[0].ip_address)
        return sessionInfo
      })
    }
    return getIP()
  }).catch(error => console.log(error))
}

function checkConnection(sessionInfo) {
  const execUptime = function (sessionInfo) {
    return ssh.connect({
      host: sessionInfo.new_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey
    }).then(() => ssh.execCommand('uptime'))
  }

  function tryConnect() {
    let attempt = 0

    function loop() {
      console.log('Attempting to connect to server ' + sessionInfo.new_server.name + '. . . ')
      console.log('Attempt: ' + (attempt + 1))
      return execUptime(sessionInfo).then(results => {
        if (results.hasOwnProperty('stdout') || results.hasOwnProperty('stderr')) {
          if (results.hasOwnProperty('stdout')) {
            console.log('STDOUT: ' + results.stdout)
            return sessionInfo
          } else if (results.hasOwnProperty('stderr')) {
            console.log('command failed - STDERR: ' + results.stderr)
            attempt++
            if (attempt !== 25) {
              console.log('trying again . . . ');
              return loop()
            }
          }
        } else {
          console.log('unknown failure: ' + results)
        }
      }).catch(error => {
        console.log('failed to connect . . . ');
        attempt++
        console.error(error)
        if (attempt !== 25) {
          console.log('trying again . . . ');
          return loop()
        }
        console.log('failed to connect after 25 attempts')
      })
    }
    return loop()
  }
  return tryConnect()
}

function getShadowsocks(sessionInfo) {
  console.log('updating Shadowsocks. . . ')

  function readConfig(service, config) {
    sessionInfo[service] = {}
    sessionInfo[service][config] = config
    const streamOpts = {
      flags: 'r',
      encoding: 'utf-8',
      handle: null,
      mode: 0o666,
      autoClose: true
    }

    var streamData = []

    return ssh.connect({
      host: sessionInfo.old_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey
    }).then(session => {
      return session.requestSFTP().then(sftp => {
        const readStream = sftp.createReadStream(configurations[service][config], streamOpts)
        const stream = new Promise((resolve, reject) => {
          readStream.on('data', data => {
            streamData.push(data)
          })
          readStream.on('end', data => {
            console.log(config + ' was successfully downloaded . . . ')
            sessionInfo[service][config] = JSON.parse(streamData)
            sessionInfo[service][config].server = sessionInfo.new_server.networks.v4[0].ip_address
            resolve()
          })
          readStream.on('error', () => reject())
        })
        return stream
      })
    }).catch(error => {
      return console.error(error);
    })
  }

  function writeConfig(service, config) {
    const streamOpts = {
      flags: 'w',
      encoding: 'utf-8',
      handle: null,
      mode: 0o666,
      autoClose: true
    }

    return ssh.connect({
      host: sessionInfo.new_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey
    }).then(session => {
      return session.requestSFTP().then(sftp => {
        var configReadable = new readable
        const writeStream = sftp.createWriteStream(configurations[service][config], streamOpts)
        const stream = new Promise((resolve, reject) => {
          writeStream.on('close', () => {
            console.log(config + " transferred succesfully")
            resolve()
          })
        })

        configReadable.push(JSON.stringify(sessionInfo[service][config], null, 2) + '\n')
        configReadable.push(null)
        configReadable.pipe(writeStream)
        return stream
      }).catch(error => {
        return console.error(error)
      })
    })
  }

  return readConfig('shadowsocks', 'config.json').then(() => {
    return writeConfig('shadowsocks', 'config.json')
  }).then(() => {
    return serviceRestart('shadowsocks-libev', sessionInfo)
  }).then(results => {
    console.log(results)
    return results
  }).catch(error => {
    console.error(error)
  })
}


//service restart
function serviceRestart(service, sessionInfo) {
  console.log('restarting ' + service)
  return ssh.connect({
    host: sessionInfo.new_server.networks.v4[0].ip_address,
    username: 'root',
    privateKey: sshKey
  }).then(results => {
    return ssh.execCommand('service ' + service + ' restart && service ' + service + ' status')
  }).then(results => {
    if (results.hasOwnProperty('stdout') || results.hasOwnProperty('stderr')) {
      if (results.hasOwnProperty('stdout')) {
        console.log('STDOUT: ' + results.stdout)
        return sessionInfo
      } else {
        return console.error('STDERR: ' + results.stderr)
      }
    }
  }).catch(error => {
    return console.error(error)
  })
}

function updateDomainRecords(sessionInfo) {
  console.log('updating domain record . . .')
  const domain = sessionInfo.domain
  return client.domainRecordGetAll(domain).then(domainRecords => {
    const newRecord = {
      "type": "A",
      "data": sessionInfo.new_server.networks.v4[0].ip_address,
      "name": "@"
    }
    var targetRecord = domainRecords.filter(el => {
      return domainRecords
    })
    if (targetRecord != null) {
      targetRecord = targetRecord.filter(el => {
        return el.type === "A"
      })
      if (targetRecord[0].data === sessionInfo.old_server.networks.v4[0].ip_address) {
        console.log('the targetRecord and current server record match, updating record')
      } else {
        console.error('DNS Records do not match, skipping DNS record update.')
      }
      return client.domainRecordEdit(domain, targetRecord[0].id, newRecord).then(updatedRecord => {
        sessionInfo.domain = updatedRecord
        console.error('The new record is : \n', sessionInfo.domain)
      })
    } else {
      console.error('The record details could not be found, skipping DNS record update')
    }
  }).then(() => sessionInfo).catch(error => console.error(error))
}

getSessionInfo()
  .then(results => getCurrentServer(results))
  .then(results => startNewServer(results))
  .then(results => checkConnection(results))
  .then(results => getShadowsocks(results))
  .then(results => updateDomainRecords(results))
  .then(results => console.log('redeployment complete: \n' + results.new_server.networks.v4[0].ip_address))