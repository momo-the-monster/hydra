var eventNames = require('./models/eventNames').names;
var models = require('./models/models.js');
var hydra = require('./hydra/hydra.js');

// Set Game Model
hydra.gameModel = models.gameModel;

module.exports.respond = function(io, socket){

    reset();

    // Admin requests GameStart
    socket.on(eventNames.requestStartGame, function(){
        startGame(socket.game);
    });

    // Disconnected
    socket.on('disconnect', function () {

        if(!socket.game)
            return;

        if(socket.isAdmin) {
            if(socket.game.roomID){
                io.sockets.to(socket.game.roomID).emit(eventNames.gameOver);
                socket.game.inProgress = false; // maybe handle this from gameOver?
            }
        } else {
            if(socket.game.roomID){
                socket.game.numPlayers--;
                socket.game.numPlayersAlive--;
//                checkEndgame(socket.game);
            }
        }
    });

    function reset(){
    }

    function startGame(game) {
        game.numPlayersAlive = game.numPlayers;
        if(game.numPlayers == 1)
            game.gameType = models.gameTypes.solo;
        io.to(game.roomID).emit(eventNames.startGame, {gameType: game.gameType});
        game.inProgress = true;
    }
};