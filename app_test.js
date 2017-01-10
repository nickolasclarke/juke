"use strict";
var DigitalOceanApi = require('doapi');
var fs = require('fs');
var node_ssh = require('node-ssh')
var inquirer = require('inquirer');

var readable = require('stream').Readable

var client;
var sshKey;
var ssh = new node_ssh()

var configurations = {};
var prompt = inquirer.createPromptModule();
var promptQuestions = [
    {
        type: 'input',
        name: 'do_api_token',
        message: 'Digital Ocean token:'
    }, {
        type: 'input',
        name: 'ssh_key_location',
        message: 'Name of SSH key in ~/.ssh/ to connect to Streisand droplet:'
    }
]
var sequestOpts = {
    privateKey: sshKey,
    readyTimeout: 20000
};
var time = new Date();
var targetRecord;

//gather required info from user
function getSessionInfo() {
    var sessionInfo = {
        do_api_token: null,
        ssh_key_location: null
    }

    return prompt(promptQuestions).then(answers => {
        sessionInfo.do_api_token = answers.do_api_token
        sessionInfo.ssh_key_location = answers.ssh_key_location
        sshKey = process.env.HOME + '/.ssh/' + sessionInfo.ssh_key_location
        client = new DigitalOceanApi({token: sessionInfo.do_api_token});
        console.log(sessionInfo)
        return sessionInfo;
    }).catch(error => console.log(error))
}

//find the latest instance of streisand from Digital Ocean and store it.
function getCurrentServer(sessionInfo) {
    return client.dropletGetAll().then(droplets => {
        return droplets.filter(el => {
            if (el.name.search('streisand-') !== -1) {
                return el.name;
            }
        });
    }).then(droplet => {
        sessionInfo.old_server = droplet[0];
        console.log('The current server is: ' + sessionInfo.old_server.name +
          " " + sessionInfo.old_server.networks.v4[0].ip_address)
        return sessionInfo
    }).catch(error => console.error(error))
}

//using the return from getCurrentServer, start a new droplet using the snapshot of the old server.
function startNewServer(sessionInfo) {
    var newServerDetails = {
        "name": "streisand-" + (time.getMonth() + 1) + "-" + time.getDate() +
          "-" + time.getHours() + "." + time.getMinutes(),
        "region": "sfo2",
        //"region": oldServer.oldserver.region.slug,
        "size": "512mb",
        "image": sessionInfo.old_server.snapshot_ids[0],
        "ssh_keys": [1278744]
    };

    return client.dropletNew(newServerDetails).then(newDroplet => {
        newServerDetails = newDroplet;
        var numAttempts = 0;

        function getIP() {

            return client.dropletGet(newServerDetails.id).then(startingDroplet => {
                numAttempts++
                console.log("Find IP attempt # ", numAttempts);

                if (startingDroplet.networks.v4[0].ip_address != undefined) {
                    newServerDetails = startingDroplet;
                    console.log("newServer updated with IPv4 address: ",
                      startingDroplet.networks.v4[0].ip_address);
                    return newServerDetails;

                } else {
                    if (numAttempts > 15) {
                        console.log("failed to reach server after " + numAttempts
                          + " attempts");
                    } else {
                        return getIP();
                    }
                }
            }).then(server => {
                sessionInfo.new_server = server
                console.log(sessionInfo.new_server.name + " " +
                  sessionInfo.new_server.networks.v4[0].ip_address)
                return sessionInfo
            })
        }
        return getIP();
    }).catch(error => console.log(error))
}

function checkConnection(sessionInfo){
  var attempts = 25
  console.log('Attempting to connect to server ' + sessionInfo.new_server.name + '. . . ');
  console.log('Attempt: #1');
  function connect(attempt) {
    ssh.connect({
      host: sessionInfo.new_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey
    }).then( results => {
      return ssh.execCommand('uptime')
    }, rejection => {
      attempts--
      console.error('failed, ' + attempts +  ' attempts left . . .');
      if (attempts > 0) {
      connect(attempts);
    }
    }).then(results => {
      console.log('STDOUT: ' + results.stdout)
      console.log('STDERR: ' + results.stderr)
    }).catch(error => console.error(error))
  }
  connect(attempts)
}

//copy Shadowsocks config from old server onto new server
function getShadowsocks() {
  return ssh.connect({
      //host: sessionInfo.new_server.networks.v4[0].ip_address,
      host: '138.197.193.189',
      username: 'root',
      privateKey: process.env.HOME + '/.ssh/do.priv'
    }).then( () => {
      return ssh.getFile('/etc/shadowsocks-libev/config.json', process.env.HOME + '/config.json.transfered')
    }).then( () => {
      return console.log("The File's contents were successfully downloaded")
    }).then( () => {
      fs.readFile('/etc/passwd', (error, data) => {
        if (error) throw error
        console.log(data)
        sessionInfo.configurations.shadowsocks.server = newServer.networks.v4[0].ip_address
      })
    }).then( () => {
      return ssh.putfile('/path/to/local/file.json', '/path/to/remote/file.json')
    }).catch(error =>{
      console.error('there is a problem', error)
    })
}
getSessionInfo().then(getCurrentServer).then(startNewServer).then(checkConnection)



--------------------------------------------------------------------------------

  function updateShadowsocks() {
    console.log("updateShadowsocks callback started.");
    configurations.shadowsocks.server = newServer.networks.v4[0].ip_address;
    //this is a real hack that requires success, rework.
    updateConfig(serviceRestart);
  };

  function updateConfig(callback) {
    var configReadable = new readable;
    var writer = sequest.put('root@' + newServer.networks.v4[0].ip_address,
    '/etc/shadowsocks-libev/config.json', {
      mode: '0640',
      privateKey: sshKey,
      readyTimeout: 20000
    });

    configReadable.push(JSON.stringify(configurations.shadowsocks, null, 2) + '\n');
    configReadable.push(null);
    configReadable.pipe(writer);
    writer.on('close', function () {
      console.log("finished writing");
      callback('shadowsocks-libev');
    })
  };
  streamToString(oldConfigSSH, configurations, 'shadowsocks', updateShadowsocks);
};


//helper function to push stream into a string variable
 function streamToString (stream, result, resultKey, callback) {
   var data = '';
   var chunk;

   stream.on('readable', function() {
       while ((chunk=this.read()) != null) {
           data += chunk;
           console.log("Reading data . . .");
       }
   });

   stream.on('end', function() {
     data = JSON.parse(data);
     console.log("reading complete");
     result[resultKey] = data;
     callback();
   });
 };

 //genereic sequest callback
 function sequestResponse (error, stdout) {
    if (error) {
      throw error;
    } else {
      console.log(stdout);
      return true;
    }
  };

  function sshCommand (server, options) {
    sequest('root@' + server, sequestOpts, sequestResponse);
  };


--------------------------------------------------------------------------------

//CODE YET TO BE CONVERTED AND IMPLEMENTED
/*

//service restart
function serviceRestart(service) {
  sequestOpts.command = 'service ' + service + ' restart';
  sshCommand(newServer.networks.v4[0].ip_address, sequestOpts);
};

//update domain to reflect new IP.
function updateDomainRecords(domain) {

 client.domainRecordGetAll(domain).then(function(domainRecords) {
   newRecord = {
     "type": "A",
     "data": newServer.networks.v4[0].ip_address,
     "name": "@"
   }
   targetRecord = domainRecords.filter(function(el) {
     return domainRecords;
   });
   if (targetRecord != null){
     targetRecord = targetRecord.filter(function(el) {
       return el.type === "A";
     });
     if (targetRecord[0].data === oldServer[0].networks.v4[0].ip_address) {
       console.log("the targetRecord and current server record match, updating record.");
     } else {
       throw "DNS Records do not match, skipping DNS record update."
     }
     client.domainRecordEdit(domain,targetRecord[0].id,newRecord).then(function (updatedRecord){
       console.log("The new record is : \n", updatedRecord);
     })
   } else {
     throw "The record details could not be found, skipping DNS record update"
   }
 });
}
// Verify domain record has been successfully updated against DO DNS servers



  function isActive(server, delay, timeout) {
    client.dropletGet(server).catch(function (error){
      if (error === 'Error: Request Failed: Error: read ECONNRESET') {
        console.error('there was an error, trying again:', error);
      } else {
      console.error('there was an error, aborting:', error);
    }
    }).then(function statusIs(droplet){
      if (droplet.status !='active') {
        console.log(droplet.status);
        console.log('not yet active');
        isActive(server);
      } else {
        console.log('the server status is ' + droplet.status);
      }
    });
  };

*/


var sessionInfo = {
  do_api_token: null,
  ssh_key_location: null,
  configurations: {
    shadowsocks: {
      ssRemote: '/etc/shadowsocks-libev/config.json',
      ssLocal: process.env.HOME + '/config.json.transfered'
    }
  }
}
function getShadowsocks() {

  return ssh.connect({
      //host: sessionInfo.new_server.networks.v4[0].ip_address,
      host: '138.197.193.189',
      username: 'root',
      privateKey: process.env.HOME + '/.ssh/do.priv'
    }).then( () => {
      return ssh.getFile('/etc/shadowsocks-libev/config.json', process.env.HOME + '/config.json.transfered')
    }).then( () => {
      return console.log("The File's contents were successfully downloaded")
    }).then( () => {
      const readFile = fs.readFileSync(sessionInfo.configurations.shadowsocks.ssLocal, 'utf-8')
      console.log(readFile)
      sessionInfo.configurations.shadowsocks.configFile = JSON.parse(readFile)
      sessionInfo.configurations.shadowsocks.configFile.server = '123.456.789.1'
      return ('resolved')
    }).then( () => {
      const writeFile = fs.writeFileSync(sessionInfo.configurations.shadowsocks.ssLocal, JSON.stringify(sessionInfo.configurations.shadowsocks.configFile))
      return console.log('It\'s saved!')
    }).catch(error =>
    console.error(error))
  }





  function stream() {

  return ssh.connect({
      //host: sessionInfo.new_server.networks.v4[0].ip_address,
      host: '138.197.193.189',
      username: 'root',
      privateKey: process.env.HOME + '/.ssh/do.priv'
    }).then(createRead)

   var streamData = ''
    function createRead() {
      this.requestSFTP().then( sftp => {
        const readStream = sftp.createReadStream(sessionInfo.configurations.shadowsocks.ssRemote, { flags: 'r',
          encoding: 'utf-8',
          handle: null,
          mode: 0o666,
          autoClose: true
        })

        readStream.on('data', file => {
          streamData += file;
        })
        readStream.on('end', data => {
          console.log(streamData)
          return streamData
        }
      }
        )}
  }