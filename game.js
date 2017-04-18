var eventNames = require('./models/eventNames').names;
var models = require('./models/models.js');
var hydra = require('./hydra/hydra.js');

// Set Game Model
hydra.gameModel = models.gameModel;

module.exports.respond = function(io, socket){

    reset();

    socket.on(eventNames.buttonPressed, function(value){
        io.sockets.to(socket.game.adminID).emit(eventNames.playerPressedButton, socket.username, value);
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
            }
        }
    });

    function reset(){
    }
};