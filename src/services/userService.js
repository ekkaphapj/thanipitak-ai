const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

function createUserService(db) {
  function findById(id) {
    return db.prepare('SELECT id, username, name, role, station_id FROM users WHERE id = ?').get(id);
  }

  function verifyCredentials(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return null;
    const ok = bcrypt.compareSync(password || '', user.password_hash);
    if (!ok) return null;
    return user;
  }

  function signToken(user) {
    return jwt.sign(
      {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        stationId: user.station_id,
      },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );
  }

  function publicProfile(user) {
    const station = user.station_id
      ? db.prepare('SELECT name, province FROM stations WHERE id = ?').get(user.station_id)
      : null;
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      stationId: user.station_id,
      stationName: station?.name || null,
      province: station?.province || null,
    };
  }

  return { findById, verifyCredentials, signToken, publicProfile };
}

module.exports = { createUserService };
