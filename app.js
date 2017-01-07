"use strict";
var DigitalOceanApi = require('doapi');
var ping = require('ping');
var fs = require('fs');
var inquirer = require('inquirer');
var sequest = require('sequest');

var readable = require('stream').Readable

var client;
var sshKey;
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
        sshKey = fs.readFileSync(process.env.HOME + "/.ssh/" +
          sessionInfo.ssh_key_location)
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

getSessionInfo().then(getCurrentServer).then(startNewServer)

//CODE YET TO BE CONVERTED AND IMPLEMENTED
/*
//try to ssh and run `uptime` in a loop to determine when the droplet is available
function checkConnection(serverIP, attempts) {
  sequestOpts.command = 'uptime';
  var results = function (error, stdout) {
    if (error) {
      console.error(error);
      checkConnection(serverIP, attempts - 1);
    } else {
      console.log('sucessfully connected to server' + stdout);
    }
  }

  if (attempts < 1) {
    console.log('Unable to connect to ' + serverIP + 'Aborting.');
  } else {
    console.log('attempting to connect to ' + serverIP);
    sequest('root@' + serverIP, sequestOpts, results);
  }
};

//copy Shadowsocks config from old server onto new server
function getShadowsocks() {
  var oldConfigSSH = sequest.get('root@' + oldServer[0].networks.v4[0].ip_address,
  '/etc/shadowsocks-libev/config.json', sequestOpts, sequestResponse);
  configurations.shadowsocks = {};

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

function destroyOldServer(dropletID) {
  return client.dropletDestroy(dropletID).then(function (destroyedDroplet) {
    return console.log(destroyedDroplet);
  });
};

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
