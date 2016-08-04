exports.gameModel = {
    "roomID" : null,
    "adminID" : null,
    "inProgress" : false,
    "state" : null,
    "numPlayers" : 0
};

Object.spawn = function (parent, props) {
    var defs = {}, key;
    for (key in props) {
        if (props.hasOwnProperty(key)) {
            defs[key] = {value: props[key], enumerable: true};
        }
    }
    return Object.create(parent, defs);
};