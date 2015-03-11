/**
 * Manages a user in a chat session
 * @param isInitiator
 *  determines if the user is the initiator/host of
 *  the chat
 * @constructor
 */
Client = function(isInitiator) {
  var self = this;
  this.isInitiator = isInitiator;
  this.messages = [];

  this.addMessage = function(message) {
    self.messages.push(message);
  };

  this.clearMessages = function() {
    self.messages = [];
  };

  this.toString = function() {
    return '{ '+ self.isInitiator +', '+ self.messages.length +' }';
  }
}

/**
 * Manges a video chat session containing information about
 * the 2 users in a chat.
 * @constructor
 */
Room = function() {
  var self = this;
  var clientMap = {}; //map of key/value pair for client objects

  this.getOccupancy = function() {
    var keys = Object.keys(clientMap);
    return keys.length;
  };

  this.hasClient = function(clientId) {
    return clientMap[clientId];
  }

  this.join = function(clientId, callback) {
    var clientIds = Object.keys(clientMap);
    var otherClient = clientIds.length > 0 ? clientMap[clientIds[0]] : null;
    var isInitiator = otherClient == null;
    var client = new Client(isInitiator);
    clientMap[clientId] = client;
    if (callback) callback(null, client, otherClient);
  };

  this.removeClient = function(clientId, callback) {
    delete clientMap[clientId];
    var otherClient = clientIds.length > 0 ? clientMap[clientIds[0]] : null;
    callback(null, true, otherClient);
  };

  this.getClient = function(clientId) {
    return clientMap[clientId];
  }

  this.toString = function() {
    return JSON.stringify(Object.keys(clientMap));
  };
};

/**
 * Manages a collection of rooms to maintain video chat sessions.
 * The purpose of this class is to allow overloading this class
 * to implement memcache or redis cluser for handling large scale
 * concurrent video chat sessions.
 * @constructor
 */
Rooms = function() {
  var self = this;
  var roomMap = {}; //map of key/value pair for room objects

  this.get = function(roomCacheKey, callback) {
    var room = roomMap[roomCacheKey];
    callback(null, room);
  };

  this.create = function(roomCacheKey, callback) {
    var room = new Room;
    roomMap[roomCacheKey] = room;
    callback(null, room);
  };

  this.createIfNotExist = function(roomCacheKey, callback) {
    self.get(roomCacheKey, function(error, room) {
      if (error) {
        callback(error);
        return;
      }
      if (!room) {
        self.create(roomCacheKey, callback);
      } else {
        callback(error, room);
      }
    });
  }
};

module.exports = Rooms;