// Local synthetic acceptance: prohibit all non-loopback TCP connections.
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let input = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof input === 'object' ? input.host || input.hostname || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    const error = new Error('Synthetic acceptance blocks outbound provider traffic'); error.code = 'ENETUNREACH'; throw error;
  }
  return connect.apply(this, args);
};
