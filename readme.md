# Hydra Node Server
Enabling Multiplayer experiences using people's own devices

## Installation
Clone the repo and use `npm install`

## Usage
This project includes the Hydra server and a barebones application as an example.
Everything specific to Hydra lives in the 'hydra' folder and should probably not be touched.
* game.js holds the game logic for your game/app.
* models
  * eventNames.js should contain custom events for your game/app
  * models.js should contain custom objects for your game/app
* public contains files used by your frontend (mostly javascript and css)
* routes
  * index.js is a simple express router to enable different endpoints
* test contains some unit tests - run them with `mocha test`
* views contain the jade/pug templates used by the rendering engine to serve up your front-end pages

## History

0.2
04/19/17
Added tests
Simplified demo 'game'
Cleaned up codebase

0.1
08/14/16
Basic working version

## Credits

Written by Surya Buchwald
Inspired by Jackbox.tv and Kevin's Experiments

## License
MIT