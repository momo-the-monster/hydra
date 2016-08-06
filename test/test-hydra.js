var should =  require('should');
var io = require('socket.io-client');
var hydraEvent = require('../hydra/models/eventNames').names;
var socketURL = 'http://localhost:3001';
var port = 3001;

var app, server;
var options = {
    transports: ['websocket'],
    'force new connection': true
};

describe("Hydra Server",function(){

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

    it('Should remember a user\'s name and emit it when they join a room', function (done) {
        var admin = io.connect(socketURL, options);
        admin.on('connect', function (data) {
            admin.emit(hydraEvent.adminLogin, function (roomId) {
                var client = io.connect(socketURL, options);
                client.on('connect', function (data) {
                    client.emit(hydraEvent.playerLogin, 'mocha-test-user');
                    client.emit(hydraEvent.playerJoinRoom, roomId, function (data) {
                        if (data.success == true) {
                            client.on(hydraEvent.playerJoined, function (username) {
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

});