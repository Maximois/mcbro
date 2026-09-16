'use strict';

function shouldAutoClearPerchanceStorage(opts = {}) {
  if (typeof opts.force !== 'undefined') return Boolean(opts.force);
  return false;
}

module.exports = {
  shouldAutoClearPerchanceStorage
};
