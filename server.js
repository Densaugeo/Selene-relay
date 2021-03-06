process.title = 'selene-relay';

var mqtt = require('mqtt');
var nconf = require('nconf');
var repl = require('repl');
var skirnir = require('skirnir');
var util = require('util');
var winston = require('winston');

// Testing
var SeleneParser = require('selene-packets');

//////////////
// Settings //
//////////////

nconf.argv().env();

nconf.file(__dirname + '/config.json');

nconf.defaults({
  remoteURL: 'ws://localhost:8088/',
  baud: 115200,
  silent: false,
  logLevelConsole: 'info',
  logLevelFile: 'info',
  logFile: __dirname + '/relay.log',
  logFileSize: 100*1024,
  repl: false
});

var logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      level: nconf.get('logLevelConsole'),
      silent: nconf.get('silent'),
      timestamp: true,
      colorize: true
    }),
    new winston.transports.File({
      level: nconf.get('logLevelFile'),
      silent: nconf.get('silent'),
      timestamp: true,
      filename: nconf.get('logFile'),
      json: false,
      maxFiles: 1,
      maxsize: nconf.get('logFileSize'),
      tailable: true
    }),
  ]
});

//////////////////////////
// Connection to server //
//////////////////////////

var mqtts = {};
var mqtt_caches = {};

// Keys are serial connections, values are arrays of Selene addresses
var mqtt_directory = {};

var start_mqtt = function(address, cache) {
  var mqtt_to_server = mqtt.connect('mqtt://localhost:1883', {
    queueQoSZero: false,
    will: {
      topic: 'Se/' + address + '/connection',
      payload: Buffer([0]),
      retain: true
    }
  });
  
  logger.info('Connecting Se/' + address + ' to mqtt://localhost:1883...');
  
  mqtt_to_server.on('connect', function() {
    logger.info('Connected Se/' + address + ' to mqtt://localhost:1883');
    
    mqtt_to_server.publish('Se/' + address + '/connection', Buffer([1]), { retain: true, qos: 0 });
    
    mqtt_to_server.subscribe('Se/' + address + '/pin/+/r');
    
    for(var i in cache) {
      mqtt_to_server.publish(i, cache[i], { retain: true, qos: 0 });
    }
  });
  
  mqtt_to_server.on('packetsend', (packet) => {
    if(packet.cmd === 'publish') {
      logger.verbose('Sent to MQTT:', {
        topic: packet.topic,
        message: packet.payload.length > 4 ? packet.payload.toString('UTF-8') : util.inspect(packet.payload)
      });
    }
  });
  
  mqtt_to_server.on('close', () => logger.info('Disconnected Se/' + address + ' from mqtt://localhost:1883'));
  
  mqtt_to_server.on('error', e => logger.error('MQTT client error:', e.toString()));
  
  mqtt_to_server.on('message', onmessage);
  
  return mqtt_to_server;
}

var onmessage = function(topic, message) {
  logger.verbose('MQTT received:', {
    topic: topic,
    message: message.length > 4 ? message.toString('UTF-8') : util.inspect(message) 
  });
  
  var buffer = SeleneParser.Packet.fromMqtt(topic, message).toBuffer();
  
  if(buffer !== null) {
    skirnir.broadcast(buffer);
    logger.debug('Skirnir sent:', util.inspect(buffer));
  } else {
    logger.verbose('Packet from MQTT was invalid');
  }
}

///////////////////////
// Connection to μCs //
///////////////////////

var skirnir = new skirnir({dir: '/dev', autoscan: true, autoadd: true, baud: nconf.get('baud')});

logger.info('Watching /dev/ttyUSB* and /dev/ttyACM* for Selene devices');

// All packets received from Skirnir are sent through the WebSocket
skirnir.on('message', function(e) {
  var buffer = new Buffer(e.data);
  
  logger.debug('Received from ' + e.device + ': ' + util.inspect(buffer));
  
  // If we have a Selene packet
  var packet = SeleneParser.Packet.fromBuffer(buffer);
  
  if(packet !== null) {
    var mqtt_message = packet.toMqtt();
    
    if(mqtt_caches[packet.address] === undefined) {
      mqtt_caches[packet.address] = {};
    }
    
    mqtt_caches[packet.address][mqtt_message.topic] = mqtt_message.message;
    
    if(mqtts[packet.address] === undefined) {
      mqtts[packet.address] = start_mqtt(packet.address, mqtt_caches[packet.address]);
      mqtt_directory[e.device].push(packet.address);
    } else {
      mqtts[packet.address].publish(mqtt_message.topic, mqtt_message.message, { retain: true, qos: 0 });
    }
  }
});

skirnir.on('connect', e => {
  logger.info('Connected device ' + e.device);
  
  mqtt_directory[e.device] = [];
  
  var discovery_packet = new SeleneParser.Packet(0xFFFFFFFF, 'discovery').toBuffer();
  skirnir.connections[e.device].send(discovery_packet);
  
  logger.debug('Skirnir sent to ' + e.device + ':', util.inspect(discovery_packet));
});

skirnir.on('disconnect', e => {
  logger.info('Disconnected device ' + e.device);
  
  mqtt_directory[e.device].forEach(function(v) {
    mqtts[v].publish('Se/' + v + '/connection', Buffer([0]), { retain: true, qos: 0 });
    mqtts[v].end(true, function() {
      mqtts[v].removeAllListeners();
      delete mqtts[v];
      delete mqtt_caches[v];
    });
  });
  
  delete mqtt_directory[e.device];
});

// Rest of these are just for logging
skirnir.on('add'       , e => logger.info('Added new serial device: ' + e.device));
skirnir.on('remove'    , e => logger.info('Removed serial device: '   + e.device));
skirnir.on('error'     , e => logger.error('Error event from ' + e.call + ': ' + e.error));

//////////
// REPL //
//////////

if(nconf.get('repl')) {
  var cli = repl.start({});
  
  cli.context.nconf              = nconf;
  cli.context.repl               = repl;
  cli.context.skirnir            = skirnir;
  cli.context.util               = util;
  cli.context.winston            = winston;
  cli.context.SeleneParser       = SeleneParser;
}
