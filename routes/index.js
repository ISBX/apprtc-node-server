var util = require('util');
var querystring = require('querystring');
var https = require('https');
var http = require('http');
var express = require('express');
var router = express.Router();
var Rooms = require('../lib/rooms.js');
var rooms = new Rooms();

var constants = {
  LOOPBACK_CLIENT_ID: 'LOOPBACK_CLIENT_ID',
  TURN_BASE_URL: 'https://computeengineondemand.appspot.com',
  TURN_URL_TEMPLATE: '%s/turn?username=%s&key=%s',
  CEOD_KEY: '4080218913',
  WSS_HOST_ACTIVE_HOST_KEY: 'wss_host_active_host', //memcache key for the active collider host.
  WSS_HOST_PORT_PAIRS: ['apprtc-ws.webrtc.org:443', 'apprtc-ws-2.webrtc.org:443'],
  RESPONSE_ERROR: 'ERROR',
  RESPONSE_UNKNOWN_ROOM: 'UNKNOWN_ROOM',
  RESPONSE_UNKNOWN_CLIENT: 'UNKNOWN_CLIENT',
  RESPONSE_ROOM_FULL: 'FULL',
  RESPONSE_DUPLICATE_CLIENT: 'DUPLICATE_CLIENT',
  RESPONSE_SUCCESS: 'SUCCESS',
  RESPONSE_INVALID_REQUEST: 'INVALID_REQUEST'

};



function generateRandom(length) {
  var word = '';
  for (var i = 0; i < length; i++) {
    word += Math.floor((Math.random() * 10));
  }
  return word;
}

// HD is on by default for desktop Chrome, but not Android or Firefox (yet)
function getHDDefault(userAgent) {
  if (userAgent.indexOf('Android') > -1 || userAgent.indexOf('Chrome') == -1) {
    return false;
  }
  return true;
}

// iceServers will be filled in by the TURN HTTP request.
function makePCConfig(iceTransports) {
  var config = { iceServers: [] };
  if (iceTransports) {
    config.iceTransports = iceTransports;
  }
  return config;
}

function maybeAddConstraint(constraints, param, constraint) {
  var object = {};
  if (param && param.toLowerCase() == 'true') {
    object[constraint] = true;
    constraints['optional'].push(object);
  } else if (param && param.toLowerCase() == 'false') {
    object[constraint] = false;
    constraints['optional'].push(object);
  }
  return constraints;
}

function makePCConstraints(dtls, dscp, ipv6) {
  var constraints = { optional: [] };
  maybeAddConstraint(constraints, dtls, 'DtlsSrtpKeyAgreement');
  maybeAddConstraint(constraints, dscp, 'googDscp');
  maybeAddConstraint(constraints, ipv6, 'googIPv6');
  return constraints;
}

function addMediaTrackConstraint(trackConstraints, constraintString) {
  var tokens = constraintString.split(':');
  var mandatory = true;
  if (tokens.length == 2) {
    // If specified, e.g. mandatory:minHeight=720, set mandatory appropriately.
    mandatory = (tokens[0] == 'mandatory');
  } else if (tokens.length >= 1) {
    // Otherwise, default to mandatory, except for goog constraints, which
    // won't work in other browsers.
    mandatory = !tokens[0].indexOf('goog') == 0;
  }

  if (tokens.length > 0) {
    tokens = tokens[tokens.length-1].split('=');
    if (tokens.length == 2) {
      if (mandatory) {
        trackConstraints.mandatory[tokens[0]] = tokens[1];
      } else {
        var object = {};
        object[tokens[0]] = tokens[1];
        trackConstraints.optional.push(object);
      }
    } else {
      console.error('Ignoring malformed constraint: ' + constraintString);
    }
  }
}

function makeMediaTrackConstraints(constraintsString) {
  var trackConstraints;
  if (!constraintsString || constraintsString.toLowerCase() == 'true') {
    trackConstraints = true;
  } else if (constraintsString.toLowerCase() == 'false') {
    trackConstraints = false;
  } else {
    trackConstraints = { mandatory: {}, optional: [] };
    var constraintsArray = constraintsString.split(',');
    for (var i in constraintsArray) {
      var constraintString = constraintsArray[i];
      addMediaTrackConstraint(trackConstraints, constraintString);
    }
  }
  return trackConstraints;
}

function makeMediaStreamConstraints(audio, video, firefoxFakeDevice) {
  var streamConstraints = {
    audio: makeMediaTrackConstraints(audio),
    video: makeMediaTrackConstraints(video)
  };
  if (firefoxFakeDevice) streamConstraints.fake = true;
  return streamConstraints;
}

function getWSSParameters(req) {
  var wssHostPortPair = req.query['wshpp'];
  var wssTLS = req.query['wstls'];

  if (!wssHostPortPair) {
    // Attempt to get a wss server from the status provided by prober,
    // if that fails, use fallback value.

    //TODO: setup memcache
    //var memcacheClient = memcache.Client();
    //var wssActiveHost = memcache_client.get(constants.WSS_HOST_ACTIVE_HOST_KEY);
    //if (constants.WSS_HOST_PORT_PAIRS.indexOf(wssActiveHost) > -1) {
    //  wssHostPortPair = wssActiveHost;
    //} else {
    //  console.warn('Invalid or no value returned from memcache, using fallback: '  + JSON.stringify(wssActiveHost));
      wssHostPortPair = constants.WSS_HOST_PORT_PAIRS[0];
    //}
  }

  if (wssTLS && wssTLS == 'false') {
    return {
      wssUrl: 'ws://' + wssHostPortPair + '/ws',
      wssPostUrl: 'http://' + wssHostPortPair,
      host: wssHostPortPair
    }
  } else {
    return {
      wssUrl: 'wss://' + wssHostPortPair + '/ws',
      wssPostUrl: 'https://' + wssHostPortPair,
      host: wssHostPortPair
    }
  }
}

function getVersionInfo() {
  //TODO: parse version_info.json
  return undefined;
}

function getRoomParameters(req, roomId, clientId, isInitiator) {
  var errorMessages = [];
  var userAgent = req.headers['user-agent'];
  //Which ICE candidates to allow. This is useful for forcing a call to run over TURN, by setting it=relay.
  var iceTransports = req.query['it'];

  // Which TURN transport= to allow (i.e., only TURN URLs with transport=<tt>
  // will be used). This is useful for forcing a session to use TURN/TCP, by
  // setting it=relay&tt=tcp.
  var turnTransports = req.query['tt'];

  // A HTTP server that will be used to find the right TURN servers to use, as
  // described in http://tools.ietf.org/html/draft-uberti-rtcweb-turn-rest-00.
  var turnBaseUrl = req.query['ts'];
  if (!turnBaseUrl) turnBaseUrl = constants.TURN_BASE_URL;

  /*
    Use "audio" and "video" to set the media stream constraints. Defined here:
    http://goo.gl/V7cZg

    "true" and "false" are recognized and interpreted as bools, for example:
    "?audio=true&video=false" (Start an audio-only call.)
    "?audio=false" (Start a video-only call.)
    If unspecified, the stream constraint defaults to True.

    To specify media track constraints, pass in a comma-separated list of
    key/value pairs, separated by a "=". Examples:
    "?audio=googEchoCancellation=false,googAutoGainControl=true"
    (Disable echo cancellation and enable gain control.)

    "?video=minWidth=1280,minHeight=720,googNoiseReduction=true"
    (Set the minimum resolution to 1280x720 and enable noise reduction.)

    Keys starting with "goog" will be added to the "optional" key; all others
    will be added to the "mandatory" key.
    To override this default behavior, add a "mandatory" or "optional" prefix
    to each key, e.g.
    "?video=optional:minWidth=1280,optional:minHeight=720,
    mandatory:googNoiseReduction=true"
    (Try to do 1280x720, but be willing to live with less; enable
    noise reduction or die trying.)

    The audio keys are defined here: talk/app/webrtc/localaudiosource.cc
    The video keys are defined here: talk/app/webrtc/videosource.cc
  */
  var audio = req.query['audio'];
  var video = req.query['video'];

  // Pass firefox_fake_device=1 to pass fake: true in the media constraints,
  // which will make Firefox use its built-in fake device.
  var firefoxFakeDevice = req.query['firefox_fake_device'];

  /*
   The hd parameter is a shorthand to determine whether to open the
   camera at 720p. If no value is provided, use a platform-specific default.
   When defaulting to HD, use optional constraints, in case the camera
   doesn't actually support HD modes.
   */
  var hd = req.query['hd'];
  if (hd) hd = hd.toLowerCase();
  if (hd && video) {
    var message = 'The "hd" parameter has overridden video=' + video
    console.error(message);
    errorMessages.push(message);
  }
  if (hd == 'true') {
    video = 'mandatory:minWidth=1280,mandatory:minHeight=720';
  } else if (!hd && !video && getHDDefault(userAgent)) {
    video = 'optional:minWidth=1280,optional:minHeight=720';
  }

  if (req.query['minre'] || req.query['maxre']) {
    var message = 'The "minre" and "maxre" parameters are no longer supported. Use "video" instead.';
    console.error(message);
    errorMessages.push(message);
  }

  // Options for controlling various networking features.
  var dtls = req.query['dtls'];
  var dscp = req.query['dscp'];
  var ipv6 = req.query['ipv6'];

  var debug = req.query['debug'];
  var includeLoopbackJS = '';
  if (debug == 'loopback') {
    // Set dtls to false as DTLS does not work for loopback.
    dtls = 'false';
    includeLoopbackJS = '<script src="/js/loopback.js"></script>';
  }


  /*
   TODO(tkchin): We want to provide a TURN request url on the initial get,
   but we don't provide client_id until a join. For now just generate
   a random id, but we should make this better.
   */
  var username = clientId ? clientId : generateRandom(9);
  var turnUrl = turnBaseUrl.length  > 0 ? util.format(constants.TURN_URL_TEMPLATE, turnBaseUrl, username, constants.CEOD_KEY) : undefined;

  var pcConfig = makePCConfig(iceTransports);
  var pcConstraints = makePCConstraints(dtls, dscp, ipv6);
  var offerConstraints = { mandatory: {}, optional: [] };
  var mediaConstraints = makeMediaStreamConstraints(audio, video, firefoxFakeDevice);
  var wssParams = getWSSParameters(req);
  var wssUrl = wssParams.wssUrl;
  var wssPostUrl = wssParams.wssPostUrl;
  var bypassJoinConfirmation = false; //TODO: add BYPASS_JOIN_CONFIRMATION flag in environment variable

  var params = {
    'error_messages': errorMessages,
    'is_loopback' : JSON.stringify(debug == 'loopback'),
    'pc_config': JSON.stringify(pcConfig),
    'pc_constraints': JSON.stringify(pcConstraints),
    'offer_constraints': JSON.stringify(offerConstraints),
    'media_constraints': JSON.stringify(mediaConstraints),
    'turn_url': turnUrl,
    'turn_transports': turnTransports,
    'include_loopback_js' : includeLoopbackJS,
    'wss_url': wssUrl,
    'wss_post_url': wssPostUrl,
    'bypass_join_confirmation': JSON.stringify(bypassJoinConfirmation),
    'version_info': JSON.stringify(getVersionInfo())
  };

  var protocol = req.headers['x-forwarded-proto'];
  if (!protocol) protocol = "http";
  if (roomId) {
    params['room_id'] = roomId;
    params['room_link'] =  protocol + "://" + req.headers.host + '/r/' + roomId + '?' + querystring.stringify(req.query);
  }
  if (clientId) {
    params['client_id'] = clientId;
  }
  if (typeof isInitiator === 'boolean') {
    params['is_initiator'] = JSON.stringify(isInitiator);
  }

  return params;
}

function getCacheKeyForRoom(host, roomId) {
  return host + "/" + roomId;
}

function addClientToRoom(req, roomId, clientId, isLoopback, callback) {
  var key = getCacheKeyForRoom(req.headers.host, roomId);
  rooms.createIfNotExist(key, function(error, room) {
    if (error) {
      callback(error);
      return;
    }
    var isInitiator = false;
    var error = null;
    var occupancy = room.getOccupancy();
    if (occupancy >= 2) {
      error = constants.RESPONSE_ROOM_FULL;
      callback(error, { is_initiator: isInitiator, messages:[]});
    } else if (room.hasClient(clientId)) {
      error = constants.RESPONSE_DUPLICATE_CLIENT;
      callback(error, { is_initiator: isInitiator, messages:[]});
    } else {
      room.join(clientId, function(error, client, otherClient) {
        if (error) {
          callback(error, { is_initiator: isInitiator, messages:[]});
          return;
        }
        if (client.isInitiator && isLoopback) {
          room.join(constants.LOOPBACK_CLIENT_ID);
        }
        var messages = otherClient ? otherClient.messages : [];
        if (otherClient) otherClient.clearMessages();
        console.log('Added client ' + clientId + ' in room ' + roomId);
        callback(null, { is_initiator: client.isInitiator, messages: messages, room_state: room.toString() });
      });
    }

  });
}

function saveMessageFromClient(host, roomId, clientId, message, callback) {
  var text = message;
  var key = getCacheKeyForRoom(host, roomId);
  rooms.get(key, function(error, room) {
    if (!room) {
      console.warn('Unknown room: ' + roomId);
      callback({error: constants.RESPONSE_UNKNOWN_ROOM}, false);
    } else if (!room.hasClient(clientId)) {
      console.warn('Unknown client: ' + clientId);
      callback({error: constants.RESPONSE_UNKNOWN_CLIENT}, false);
    } else if (room.getOccupancy() > 1) {
      callback(null, false);
    } else {
      var client = room.getClient(clientId);
      client.addMessage(text);
      console.log('Saved message for client ' + clientId + ':' + client.toString() + ' in room ' + roomId);
      callback(null, true);
    }
  });
}

router.get('/', function(req, res, next) {
  // Parse out parameters from request.
  var params = getRoomParameters(req, null, null, null);
  res.render("index_template", params);
});

router.post('/join/:roomId', function(req, res, next) {
  var roomId = req.params.roomId;
  var clientId = generateRandom(8);
  var isLoopback = req.query['debug'] == 'loopback';
  addClientToRoom(req, roomId, clientId, isLoopback, function(error, result) {
    if (error) {
      console.error('Error adding client to room: ' + error + ', room_state=' + result.room_state);
      res.send({result: error, params: result});
      return;
    }
    var params = getRoomParameters(req, roomId, clientId, result.is_initiator);
    params.messages = result.messages;
    //TODO(tkchin): Clean up response format. For simplicity put everything in
    //params for now.
    res.send({
      result: 'SUCCESS',
      params: params
    });
    console.log('User ' + clientId + ' joined room ' + roomId);
    console.log('Room ' + roomId + ' has state ' + result.room_state);

  });
});

router.post('/message/:roomId/:clientId', function(req, res, next) {
  var roomId = req.params.roomId;
  var clientId = req.params.clientId;
  var message = req.body;
  saveMessageFromClient(req.headers.host, roomId, clientId, message, function(error, saved) {
    if (error) {
      res.send({ result: error });
      return;
    }
    if (saved) {
      res.send({ result: constants.RESPONSE_SUCCESS });
    } else {
      //Other client joined, forward to collider. Do this outside the lock.
      //  Note: this may fail in local dev server due to not having the right
      //certificate file locally for SSL validation.
      //  Note: loopback scenario follows this code path.
      //  TODO(tkchin): consider async fetch here.
      console.log('Forwarding message to collider from room ' + roomId + ' client ' + clientId);
      var wssParams = getWSSParameters(req);
      var postOptions = {
        host: 'apprtc-ws.webrtc.org',//wssParams.host,
        port: 443,
        path: '/' + roomId + '/' + clientId,
        method: 'POST'
      };
      var postRequest = https.request(postOptions, function(httpRes) {
        if (httpRes.statusCode == 200) {
          res.send({ result: constants.RESPONSE_SUCCESS });
        } else {
          console.error('Failed to send message to collider: ' + httpRes.statusCode);
          // TODO(tkchin): better error handling.
          res.status(httpRes.statusCode);
        }
      });
      postRequest.write(message);
      postRequest.end();
    }
  });
});

router.get('/r/:roomId', function(req, res, next) {
  var roomId = req.params.roomId;
  var key = getCacheKeyForRoom(req.headers.host, roomId);
  rooms.get(key, function(error, room) {
    if (room) {
      console.log('Room ' + roomId + ' has state ' + room.toString());
      // Check if room is full
      if (room.getOccupancy() >= 2) {
        console.log('Room ' + roomId + ' is full');
        res.render('full_template', {});
        return;
      }
    }
    // Parse out room parameters from request.
    var params = getRoomParameters(req, roomId, null, null);
    // room_id/room_link will be included in the returned parameters
    // so the client will launch the requested room.
    res.render('index_template', params);
  });
});

router.post('/leave/:roomId/:clientId', function(req, res, next) {
  var roomId = req.params.roomId;
  var clientId = req.params.clientId;
  var key = getCacheKeyForRoom(req.headers.host, roomId);
  rooms.get(key, function(error, room) {
    if (!room) {
      console.warn('Unknown room: ' + roomId);
      callback({error: constants.RESPONSE_UNKNOWN_ROOM}, false);
    } else if (!room.hasClient(clientId)) {
      console.warn('Unknown client: ' + clientId);
      callback({error: constants.RESPONSE_UNKNOWN_CLIENT}, false);
    } else {
      room.removeClient(clientId, function(error, isRemoved, otherClient) {
        if (error) {
          res.send({ result: error });
          return;
        }
        if (room.hasClient(constants.LOOPBACK_CLIENT_ID)) {
          room.removeClient(constants.LOOPBACK_CLIENT_ID, function(error, isRemoved) {
            res.send({ result: constants.RESPONSE_SUCCESS });
          });
        } else {
          if (otherClient) {
            otherClient.isInitiator = true;
          }
        }
      });
    }
  });
  res.send({ result: constants.RESPONSE_SUCCESS });
});

module.exports = router;
