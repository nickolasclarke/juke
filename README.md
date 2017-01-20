# Juke
A Node.js script to reprovision a Streisand Instance to a new IP for GFW circumvention on Digital Ocean

## Prerequisites:
#### Remote:
  - A running [Streisand](https://github.com/jlund/streisand) droplet deployed on Digital Ocean
    - *Droplet name should contain the string `streisand-`. I use the convention `streisand-month-day-hour.minute` i.e. `streisand-01-20-14.46` which is what Juke will use when recreating the droplet.*
  - A Digital Ocean [API token](https://cloud.digitalocean.com/settings/api/tokens) with read/write access
  - *(optional)* A [domain configured](https://cloud.digitalocean.com/networking/domains/) on Digital Ocean with an `A` record pointing at your Streisand droplet's IP
  
#### Local:
- NPM, Node installed at `node@>=6.0.0`

## Installation and Use:
- checkout this repository and cd to dir: `git checkout git@github.com:nickolasclarke/juke.git && cd juke`
- install node dependencies: `npm install`
- run with `node app.js`

##TODO
- testing suite
- refactor to use async/await
- handle network failures gracefully
