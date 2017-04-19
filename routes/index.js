var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Hydra Test' });
});

router.get('/admin', function(req, res, next) {
    res.render('admin', { title: 'Hydra Admin' });
});

module.exports = router;
