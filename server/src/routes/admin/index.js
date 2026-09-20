const express = require('express');
const router = express.Router();

router.use('/', require('./auth'));
router.use('/devices', require('./devices'));
router.use('/videos', require('./videos'));
router.use('/playlists', require('./playlists'));
router.use('/schedules', require('./schedules'));
router.use('/stats', require('./stats'));

module.exports = router;
