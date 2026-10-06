'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const [file = require('./dev-paths.cjs').installed('data/desktop/native-control.info'), method = 'status'] = process.argv.slice(2);
if (!['status', 'quitIfIdle'].includes(method)) throw new Error('Use status or quitIfIdle');
const [magic, pipe, token] = fs.readFileSync(file, 'utf8').split('\n');
if (magic !== 'work-updates-native-v1') throw new Error('Unsupported native control descriptor');
const socket = net.createConnection(pipe);
socket.setTimeout(3000, () => socket.destroy(new Error('Native control timed out')));
socket.on('connect', () => socket.write(JSON.stringify({method, token}) + '\n'));
let response = '';
socket.setEncoding('utf8');
socket.on('data', data => {
  response += data;
  if (response.includes('\n')) {
    const result = JSON.parse(response.split('\n')[0]);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
    socket.destroy();
  }
});
socket.on('error', error => {process.stderr.write(error.message + '\n'); process.exitCode = 1;});
