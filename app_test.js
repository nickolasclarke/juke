"use strict";
var DigitalOceanApi = require('doapi');
var fs = require('fs');
var node_ssh = require('node-ssh')
var inquirer = require('inquirer');

var readable = require('stream').Readable

var client;
var sshKey;
var ssh = new node_ssh()

var configurations = {
  shadowsocks: {
    'config.json': '/etc/shadowsocks-libev/config.json'
  }
};
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
  console.log('starting new droplet. . .')
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
  console.log('Attempting to connect to server ' + sessionInfo.new_server.name + '. . . ')
  console.log('Attempt: #1')
  function connect(attempt) {
    return ssh.connect({
      host: sessionInfo.new_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey
    }).then( results => {
      return ssh.execCommand('uptime')
    }, rejection => {
      attempts--
      return console.error('failed, ' + attempts +  ' attempts left . . .')
      if (attempts > 0) {
      return connect(attempts)
    } else {
      return console.error('failed to connect to ' + sessionInfo.new_server.name);
    }
    }).then(results => {
      if(results.hasOwnProperty('stdout') || results.hasOwnProperty('stderr') ){
        if (results.hasOwnProperty('stdout')) {
          console.log('STDOUT: ' + results.stdout)
          console.log(sessionInfo.old_server);
          return sessionInfo
        } else {
          console.log('STDERR: ' + results.stderr)
          console.log(sessionInfo.old_server);
          return sessionInfo
        }
      }
    }).catch(error => {return console.error(error)})
  }
  return connect(attempts)
}

function getShadowsocks(sessionInfo) {
  console.log('updating Shadowsocks. . . ')

  function readConfig(service, config) {
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
      return session.requestSFTP().then( sftp => {
        const readStream = sftp.createReadStream(configurations[service][config], streamOpts)
        const stream = new Promise((resolve, reject) => {
          readStream.on('data', data => {
            streamData.push(data)
          })
          readStream.on('end', data => {
            console.log(config + ' was successfully downloaded . . . ')
            sessionInfo[service][config] = JSON.parse(streamData)
            sessionInfo[service][config].server = 'y' + sessionInfo.new_server.networks.v4[0].ip_address
            resolve()
          })
          readStream.on('error', () => reject())
        })
        return stream
        })
      }).catch(error =>{
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
        return session.requestSFTP().then( sftp => {
          var configReadable = new readable
          const writeStream = sftp.createWriteStream(configurations[service][config], streamOpts)
          const stream = new Promise((resolve, reject) => {
            writeStream.on('close', () => {
            console.log( config + " transferred succesfully")
            resolve()
            })
          })

          configReadable.push(JSON.stringify(sessionInfo[service][config], null, 2) + '\n')
          configReadable.push(null)
          configReadable.pipe(writeStream)
          return stream
      }).catch(error =>{
        return console.error(error)
      })
    })
  }

  readConfig('shadowsocks', 'config.json').then(() => {
    return writeConfig('shadowsocks', 'config.json')
  }).then( () => {
    return serviceRestart('shadowsocks-libev')
  }).then( results => {
    return results
    }).catch(error => {
    console.error(error)
  })
}


//service restart
function serviceRestart(service) {
  console.log('restarting ' + service)
  return ssh.connect({
    host: sessionInfo.new_server.networks.v4[0].ip_address,
    username: 'root',
    privateKey: sshKey
  }).then( results => {
    return ssh.execCommand('service ' + service + ' restart && service ' + service + ' status')
  }).then(results => {
    if(results.hasOwnProperty('stdout') || results.hasOwnProperty('stderr') ){
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


getSessionInfo().then(getCurrentServer).then(startNewServer).then(checkConnection).then(getShadowsocks)

--------------------------------------------------------------------------------
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


var sshKey = process.env.HOME + '/.ssh/do.priv'
var sessionInfo = {
    do_api_token: '418fd7abb595e8171f21915a43acf9ec561593a78d408dffa95117ee1cecdb1b',
    ssh_key_location: process.env.HOME + '/.ssh/do.priv',
    new_server:{ id: 37026008,
  name: 'test',
  memory: 512,
  vcpus: 1,
  disk: 20,
  locked: true,
  status: 'new',
  kernel: null,
  created_at: '2017-01-12T11:17:16Z',
  features: [ 'virtio' ],
  backup_ids: [],
  next_backup_window: null,
  snapshot_ids: [],
  image:
   { id: 21399384,
     name: '14.04.5 x64',
     distribution: 'Ubuntu',
     slug: 'ubuntu-14-04-x64',
     public: true,
     regions:
      [ 'nyc1',
        'sfo1',
        'nyc2',
        'ams2',
        'sgp1',
        'lon1',
        'nyc3',
        'ams3',
        'fra1',
        'tor1',
        'sfo2',
        'blr1' ],
     created_at: '2016-12-08T17:47:32Z',
     min_disk_size: 20,
     type: 'snapshot',
     size_gigabytes: 0.45 },
  volume_ids: [],
  size:
   { slug: '512mb',
     memory: 512,
     vcpus: 1,
     disk: 20,
     transfer: 1,
     price_monthly: 5,
     price_hourly: 0.00744,
     regions:
      [ 'ams1',
        'ams2',
        'ams3',
        'blr1',
        'fra1',
        'lon1',
        'nyc1',
        'nyc2',
        'nyc3',
        'sfo1',
        'sfo2',
        'sgp1',
        'tor1' ],
     available: true },
  size_slug: '512mb',
  networks: { v4: [
    {
      "ip_address": "138.197.193.189",
      "netmask": "255.255.192.0",
      "gateway": "104.236.0.1",
      "type": "public"
          }  
  ], v6: [] },
  region:
   { name: 'San Francisco 2',
     slug: 'sfo2',
     sizes:
      [ '512mb',
        '1gb',
        '2gb',
        '4gb',
        '8gb',
        '16gb',
        'm-16gb',
        '32gb',
        'm-32gb',
        '48gb',
        'm-64gb',
        '64gb',
        'm-128gb',
        'm-224gb' ],
     features:
      [ 'private_networking',
        'backups',
        'ipv6',
        'metadata',
        'install_agent',
        'storage' ],
     available: true },
  tags: [] },
    shadowsocks: {
      'config.json': null,
    }
  }

function getShadowsocks(sessionInfo) {

  function readConfig(service, config) {
    const streamOpts = { 
      flags: 'r',
      encoding: 'utf-8',
      handle: null,
      mode: 0o666,
      autoClose: true
    }

    var streamData = ''

    return ssh.connect({
      host: sessionInfo.old_server.networks.v4[0].ip_address,
      username: 'root',
      privateKey: sshKey
    }).then(session => {
      session.requestSFTP().then( sftp => {
        const readStream = sftp.createReadStream(configurations[service][config], streamOpts)
        readStream.on('data', file => {
          streamData += file
        })
        readStream.on('end', data => {
          console.log(streamData)
          sessionInfo[service][config] = JSON.parse(streamData)
          sessionInfo[service][config].server = '123.456.789.1'
        })
      })
    }).catch(error =>{
      console.error(error);
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
      session.requestSFTP().then( sftp => {
        var configReadable = new readable
        const writeStream = sftp.createWriteStream(configurations[service][config], streamOpts)

        configReadable.push(JSON.stringify(sessionInfo[service][config], null, 2) + '\n')
        configReadable.push(null)
        configReadable.pipe(writeStream)
        writeStream.on('close',function () {
            console.log( "- file transferred succesfully" )
        });
        writeStream.on('end', function () {
            console.log( "sftp connection closed" )
            conn.close()
        })
      })
    }).catch(error =>{
      console.error(error)
    })
  }

  readConfig('shadowsocks', 'config.json').then( () => {
    return writeConfig('shadowsocks', 'config.json')
  }).then( () =>{
    return sessionInfo
  }).catch(error => {
    console.error(error)
  })
}



  // update shadowsocks with sync file download/upload
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
    }).catch(error => {
    console.error(error)
  })
}