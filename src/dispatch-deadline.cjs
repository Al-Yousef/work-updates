'use strict';
function check(expiresAt, now = Date.now()) {
  if (expiresAt === undefined) return;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > 8640000000000000)
    throw Object.assign(new Error('Invalid message expiry'), {
      delivery: 'not-sent',
      code: 'MESSAGE_EXPIRY_INVALID',
    });
  if (now > expiresAt)
    throw Object.assign(
      new Error('This scheduled message expired before delivery. It was not sent.'),
      { delivery: 'not-sent', code: 'SCHEDULE_EXPIRED' },
    );
}
function admission(options) {
  check(options.expiresAt);
  const result = options.beforeDispatch?.();
  if (result === 'wait')
    throw Object.assign(new Error('The scheduled message is paused before delivery.'), {
      delivery: 'not-sent',
      code: 'SCHEDULE_PAUSED',
    });
  if (result === 'deny')
    throw Object.assign(new Error('The scheduled message was cancelled before delivery.'), {
      delivery: 'not-sent',
      code: 'SCHEDULE_CANCELLED',
    });
}
module.exports = { check, admission };
