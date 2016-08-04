var should =  require('should');
var io = require('socket.io-client');
var gameTypes = require('../models/models').gameTypes;
var simonEvent = require('../models/eventNames').names;
var hydraEvent = require('../hydra/models/eventNames').names;
var socketURL = 'http://localhost:3001';
var port = 3001;

var app, server;
var options = {
    transports: ['websocket'],
    'force new connection': true
};

describe("Simon Server",function(){

    // bootstrap the server for the tests
    beforeEach(function (done) {
        app = require('../app');
        app.set(port);
        server = require('http').createServer(app);
        app.io.attach(server);
        server.listen(port);
        done();
    });

    // close down the server when done
    afterEach(function (done){
        server.close();
        done();
    });

    it('Should allow connection', function (done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function(data){
            admin.disconnect();
            done();
        })
    });

    it('Should return a room on adminLogin', function (done) {
        var admin = io.connect(socketURL, options);
        admin.on('connect', function(data){
            admin.emit(hydraEvent.adminLogin, function(roomId){
                if(roomId.length > 0){
                    admin.disconnect();
                    done();
                }
            });
        });
    });

    it('Should end the game if the Admin leaves', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            client.on(simonEvent.gameOver, function(){
                                done();
                            });
                            admin.disconnect();
                        }
                    });
                });
            });
        });
    });

    it('Should decrement numPlayers by one when a player leaves');
    it('Should end the game if numPlayers is 0');

    it('Should allow a user to join an existing room', function (done) {
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            client.disconnect();
                            admin.disconnect();
                            done();
                        }
                    });
                });
            });
        });
    });

    it('Should not allow a user to join the room of a game in progress', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            admin.emit(simonEvent.requestStartGame);
                            admin.on(simonEvent.startGame, function () {
                                var client2 = io.connect(socketURL, options);
                                client2.on('connect', function(data){
                                    client2.emit(hydraEvent.playerLogin, 'mocha-test-user-2');
                                    client2.emit(hydraEvent.playerJoinRoom, roomId, function(data){
                                        if(data.success == false){
                                            client2.disconnect();
                                            client.disconnect();
                                            admin.disconnect();
                                            done();
                                        } else {
                                            throw new Error("Client was joined to room, this shouldn't happen");
                                        }
                                    })
                                })
                            });
                        }
                    });
                });
            });
        });
    });

    it('Should remember a user\'s name and emit it when they join a room', function (done) {
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            client.on(simonEvent.playerJoined, function (username) {
                                if(username == 'mocha-test-user'){
                                    client.disconnect();
                                    admin.disconnect();
                                    done();
                                }
                            });
                        }
                    });
                });
            });
        });
    });

    it('Should return success:false if a user tries to join an non-existing room', function (done) {
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, 'AAAA', function (data) {
                        if (data.success == false) {
                            client.disconnect();
                            admin.disconnect();
                            done();
                        }
                    });
                });
            });
        });
    });

    it('Should send startGame after admin sends requestStartGame', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function(data){
            admin.emit(hydraEvent.adminLogin, function(roomId){
                if(roomId.length > 0){
                    admin.emit(simonEvent.requestStartGame);
                    admin.on('startGame', function(){
                        admin.disconnect();
                        done();
                    });
                }
            });
        });
    });

    it('Should return a gameType in startGame', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function(data){
            admin.emit(hydraEvent.adminLogin, function(roomId){
                if(roomId.length > 0){
                    admin.emit(simonEvent.requestStartGame);
                    admin.on('startGame', function(data){
                        if(data.gameType != null){
                            admin.disconnect();
                            done();
                        }
                    });
                }
            });
        });
    });

    it('Should start a solo game with only one player connected', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            admin.emit(simonEvent.requestStartGame);
                            admin.on('startGame', function (data) {
                                if(data.gameType == gameTypes.solo){
                                    admin.disconnect();
                                    client.disconnect();
                                    done();
                                }
                            });
                        }
                    });
                });
            });
        });
    });

    it('Should start a vs game if two players are connected', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user-1');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            // Join Second Client in
                            var client2 = io.connect(socketURL, options);
                            client2.on('connect', function (data) {
                                client2.emit(hydraEvent.playerLogin, 'mocha-test-user-2');
                                client2.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                                    if (data.success == true) {
                                        admin.emit(simonEvent.requestStartGame);
                                        admin.on('startGame', function (data) {
                                            if (data.gameType == gameTypes.vs) {
                                                admin.disconnect();
                                                client.disconnect();
                                                done();
                                            }
                                        });
                                    }
                                });
                            });
                        }
                    });
                });
            });
        });
    });

    it('Should start a game of type team if the admin has requested it');

    it('Should send a pattern to a player once the game has started', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            admin.emit(simonEvent.requestStartGame);
                            admin.on('startGame', function () {
                                admin.emit(simonEvent.setPattern, [1]);
                                client.on(simonEvent.setPattern, function(pattern){
                                    admin.disconnect();
                                    client.disconnect();
                                    done();
                                })
                            });
                        }
                    });
                });
            });
        });
    });

    it('Should end the game after a player gets two right and one wrong', function(done){
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            admin.emit(simonEvent.requestStartGame);
                            admin.on('startGame', function () {
                                var turn = 1;
                                admin.emit(simonEvent.setPattern, [1]);
                                client.on(simonEvent.setPattern, function(pattern) {
                                    if (turn == 1) {
                                        client.emit(simonEvent.playerPatternComplete);
                                    } else if (turn == 2) {
                                        client.emit(simonEvent.playerPatternComplete);
                                    } else if (turn == 3) {
                                        client.emit(simonEvent.playerFailed);
                                    }
                                    turn++;
                                });
                                admin.on(simonEvent.playerPatternComplete, function(){
                                   if(turn == 2){
                                       admin.emit(simonEvent.setPattern, [1,2]);
                                   } else if(turn == 3){
                                       admin.emit(simonEvent.setPattern, [1,2,3]);
                                   }
                                });
                                admin.on(simonEvent.gameOver, function(){
                                    admin.disconnect();
                                    client.disconnect();
                                    done();
                                });
                            });
                        }
                    });
                });
            });
        });
    })

});