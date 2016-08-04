// Third-Party
var shuffle = require('knuth-shuffle').knuthShuffle;

// Internal
var roomCodes = shuffle(require('./models/rooms').fourLetter);

var hydra = {
    eventNames: require('./models/eventNames').names,
    games: {},
    gameModel: require('./models/models').gameModel
};

hydra.respond = function(io, socket) {

    // Admin Login
    socket.on(hydra.eventNames.adminLogin, function(callback){
        socket.isAdmin = true;
        var roomID = hydra.getRoomID().toUpperCase();
        if(roomID) {
            socket.join(roomID);
            callback(roomID);
            socket.game = hydra.createGame(roomID, socket.id);
        }
    });

    // Player Login, store the username in the socket session for this client
    socket.on(hydra.eventNames.playerLogin, function (username) {
        socket.username = username;
    });

    // Player Joins a Room
    socket.on(hydra.eventNames.playerJoinRoom, function(roomId, fn){
        roomId = roomId.toUpperCase();

        // If room exists, add user to room and game. store reference to game in user socket
        if(io.sockets.adapter.rooms[roomId]){
            var game = hydra.games[roomId];

            // don't allow users to join in-progress games
            if(game.inProgress)
                fn({'success': false});

            socket.join(roomId);
            fn({'success':true});

            game.numPlayers++;
            socket.game = game;

            // tell the room
            io.to(roomId).emit(hydra.eventNames.playerJoined, socket.username);

        } else {
            // otherwise tell the player it didn't work
            fn({'success': false});
        }
    });

    // Disconnected
    socket.on('disconnect', function () {

        if(!socket.game)
            return;

        if(socket.isAdmin) {
            // tell the room the admin has left, return the roomID to the pool
            if(socket.game.roomID){
                io.sockets.to(socket.game.roomID).emit(hydra.eventNames.adminLeft);
                roomCodes.push(socket.game.roomID);
            }
        } else {
            // tell the room that the player has left
            if(socket.game.roomID){
                io.sockets.to(socket.game.roomID).emit(hydra.eventNames.playerLeft, socket.username);
            }
        }
    });
};

hydra.getRoomID = function(){
    if(roomCodes.length > 0)
        return roomCodes.shift();
    else
        return null;
};

hydra.createGame = function(roomID, adminID){
    // hydra.gameModel has probably been overwritten by the game, this is good
    var game = Object.spawn(hydra.gameModel);
    game.roomID = roomID;
    if(adminID != null)
        game.adminID = adminID;
    hydra.games[roomID] = game;
    return game;
};

module.exports = hydra;